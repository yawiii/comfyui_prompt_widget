import json
import os
import requests
import re
import time
import hmac
import base64
import hashlib
from .lib.cache import cache_manager

class LLMExpandNode:
    # 添加类变量
    _debug = False
    
    def __init__(self):
        self.config = self.load_config()
    
    @classmethod
    def set_debug(cls, debug=False):
        """设置调试模式"""
        cls._debug = debug
        return cls
    
    def log(self, *args, force=False):
        """有条件地打印日志"""
        if self._debug or force:
            message = ' '.join(str(arg) for arg in args)
            print(f"[LLMExpand] {message}")
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True}),
            },
            "optional": {
                "_node_id": ("STRING", {"default": "", "hidden": True})  # 添加隐藏的节点ID输入
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("expanded_text",)
    CATEGORY = "text"
    FUNCTION = "expand_text"
    
    def load_config(self):
        config_path = os.path.join(os.path.dirname(__file__), "config.json")
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    
    def detect_language(self, text):
        """
        检测文本语言
        简单实现：通过中文字符比例判断是否为中文
        """
        # 计算中文字符的比例
        chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
        total_chars = len(text.strip())
        
        if total_chars == 0:
            return "unknown"
        
        chinese_ratio = chinese_chars / total_chars
        
        # 如果中文字符比例超过30%，认为是中文
        if chinese_ratio > 0.3:
            return "zh"
        else:
            return "en"
    
    def generate_zhipu_auth_header(self, api_key):
        """生成智谱API的认证头"""
        # 智谱API的认证方式
        api_key_parts = api_key.split('.')
        if len(api_key_parts) != 2:
            raise ValueError("智谱API密钥格式不正确，应为 {id}.{secret} 格式")
        
        api_key_id, api_key_secret = api_key_parts
        
        # 生成时间戳
        timestamp = int(time.time())
        
        # 生成签名
        signature_str = f"{timestamp}\n{api_key_id}"
        signature = hmac.new(
            api_key_secret.encode('utf-8'),
            signature_str.encode('utf-8'),
            hashlib.sha256
        ).digest()
        signature_base64 = base64.b64encode(signature).decode('utf-8')
        
        # 构建认证头
        auth_header = f"Bearer {api_key_id}.{timestamp}.{signature_base64}"
        return auth_header
    
    def call_llm_api(self, text):
        """调用大模型API"""
        config = self.config["llm_expand"]
        api_base = config["api_base"]
        api_key = config["api_key"]
        
        # 检测用户输入的语言
        detected_language = self.detect_language(text)
        self.log(f"检测到用户输入语言: {detected_language}")
        
        # 根据检测到的语言构建消息
        messages = [
            {"role": "system", "content": config["system_prompt"]}
        ]
        
        # 如果检测到语言，添加一条语言设置消息
        if detected_language == "zh":
            messages.append({"role": "user", "content": "请使用中文回答我的问题。"})
        elif detected_language == "en":
            messages.append({"role": "user", "content": "Please answer my questions in English."})
        
        # 添加用户的实际问题
        messages.append({"role": "user", "content": text})
        
        # 构建请求头和数据
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        
        # 构建请求数据
        data = {
            "model": config["model"],
            "messages": messages,
            "temperature": config["temperature"],
            "max_tokens": config["max_tokens"]
        }
        
        try:
            self.log(f"调用API: {api_base}")
            response = requests.post(
                api_base,
                headers=headers,
                json=data,
                timeout=30
            )
            response.raise_for_status()
            result = response.json()
            
            # 返回生成的文本
            if "choices" in result and len(result["choices"]) > 0:
                return result["choices"][0]["message"]["content"]
            else:
                raise Exception(f"API返回格式异常: {result}")
                
        except Exception as e:
            raise Exception(f"API调用失败: {str(e)}")
    
    def expand_text(self, text, _node_id=""):
        try:
            # 检查API密钥是否已配置
            api_key = self.config["llm_expand"]["api_key"]
            if not api_key or api_key == "你的API密钥":
                print("扩写失败: 请在设置界面配置LLM API密钥")
                return (f"【扩写失败: 请在设置界面配置LLM API密钥】\n{text}",)
            
            # 调用API进行扩写
            expanded_text = self.call_llm_api(text)
            
            # 记录历史
            if _node_id:
                cache_manager.init_history(_node_id)
                cache_manager.record_history(_node_id, text)
            
            return (expanded_text,)
        except Exception as e:
            error_msg = str(e)
            print(f"扩写出错: {error_msg}")
            if "auth" in error_msg.lower() or "api key" in error_msg.lower() or "apikey" in error_msg.lower():
                return (f"【扩写失败: LLM认证错误】\n{text}",)
            else:
                return (f"【扩写失败: {error_msg}】\n{text}",)

    @classmethod
    def update_config(cls, config):
        """
        更新节点配置
        @param config: 新的配置字典
        """
        try:
            if not config:
                return False
                
            # 更新LLM配置
            if "api_key" in config:
                cls.API_KEY = config["api_key"]
            if "api_base" in config:
                cls.API_BASE = config["api_base"]
            if "model" in config:
                cls.MODEL = config["model"]
            if "temperature" in config:
                cls.TEMPERATURE = float(config["temperature"])
            if "max_tokens" in config:
                cls.MAX_TOKENS = int(config["max_tokens"])
            if "system_prompt" in config:
                cls.SYSTEM_PROMPT = config["system_prompt"]
                
            return True
        except Exception as e:
            print(f"更新LLM节点配置时出错: {str(e)}")
            return False

NODE_CLASS_MAPPINGS = {
    "LLMExpandNode": LLMExpandNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LLMExpandNode": "LLM Text Expander"
} 