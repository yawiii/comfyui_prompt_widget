import os
import json
import hashlib
import random
import requests
import time

# 导入颜色模块
from .colors import Colors, MODULE_BAIDU, success, error, warning, info, content, format_log

class BaiduTranslator:
    # 百度错误码对应的中文描述
    ERROR_CODES = {
        "52000": "成功",
        "52001": "请求超时，检查请求query是否超长，以及原文或译文参数是否在支持的语种列表里",
        "52002": "系统错误，请重试",
        "52003": "未授权用户，请检查appid是否正确或者服务是否开通",
        "54000": "必填参数为空，请检查是否少传参数",
        "54001": "签名错误，请检查您的签名生成方法",
        "54003": "访问频率受限，请降低您的调用频率，或在控制台进行身份认证后切换为高级版/尊享版",
        "54004": "账户余额不足，请前往管理控制台为账户充值",
        "54005": "长query请求频繁，请降低长query的发送频率，3s后再试",
        "58000": "客户端IP非法，检查个人资料里填写的IP地址是否正确",
        "58001": "译文语言方向不支持，检查译文语言是否在语言列表里",
        "58002": "服务当前已关闭，请前往管理控制台开启服务",
        "58003": "此IP已被封禁，同一IP当日使用多个APPID发送翻译请求，该IP将被封禁当日请求权限",
        "90107": "认证未通过或未生效，请前往我的认证查看认证进度",
        "20003": "请求内容存在安全风险，请检查请求内容"
    }
    
    def __init__(self):
        self._session = None
        self.config = self._load_config()
        self._debug = False  # 控制是否输出详细调试信息
        self._paragraph_index = 0  # 增加段落索引计数器
    
    def _load_config(self):
        """加载配置文件"""
        current_path = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
        config_path = os.path.join(current_path, "config.json")
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(format_log(MODULE_BAIDU, f"加载配置文件失败: {e}", 'error'))
            return {"prompt_translate": {"appid": "", "key": ""}}
    
    @property
    def session(self):
        """获取或创建会话对象"""
        if self._session is None:
            self._session = requests.Session()
        return self._session
    
    def _generate_salt(self):
        """生成随机数"""
        return str(random.randint(32768, 65536))
    
    def _generate_sign(self, appid, query, salt, key):
        """生成签名"""
        sign_str = appid + query + salt + key
        return hashlib.md5(sign_str.encode()).hexdigest()
    
    def translate_text(self, text, from_lang="auto", to_lang="auto", retry_count=3):
        """
        翻译单个文本片段
        这是核心翻译方法，仅负责与百度API通信
        """
        if not text.strip():
            return {"status": "success", "text": ""}
        
        appid = self.config["prompt_translate"]["appid"]
        key = self.config["prompt_translate"]["key"]
        
        if not appid or not key:
            print(format_log(MODULE_BAIDU, "未配置API密钥", 'error'))
            return {"status": "error", "message": "翻译失败：请在设置界面中配置翻译API"}
        
        if self._debug:
            print(format_log(MODULE_BAIDU, f"开始翻译，长度: {len(text)}字符",))

        
        for attempt in range(retry_count):
            try:
                salt = self._generate_salt()
                sign = self._generate_sign(appid, text, salt, key)
                
                # 只在调试模式下打印详细信息
                if self._debug:
                    paragraph_info = f"段落 #{self._paragraph_index}，长度: {len(text)}字符"
                    retry_info = f"尝试 #{attempt+1}/{retry_count}"
                    print(f"{MODULE_BAIDU} {paragraph_info} - {retry_info}")
                
                # 构建请求参数
                request_params = {
                    "q": text,
                    "from": from_lang,
                    "to": to_lang,
                    "appid": appid,
                    "salt": salt,
                    "sign": sign
                }
                
                # 使用POST请求调用API
                if self._debug:
                    print(format_log(MODULE_BAIDU, "发送请求到百度API...", 'info'))
                
                response = self.session.post(
                    "https://fanyi-api.baidu.com/api/trans/vip/translate",
                    data=request_params,
                    timeout=10
                )
                
                # 记录状态码但不打印太多信息
                status_code = response.status_code
                if status_code != 200:
                    print(format_log(MODULE_BAIDU, f"HTTP错误: {status_code}", 'error'))
                    if attempt < retry_count - 1:
                        delay = (attempt + 1) * 2
                        print(format_log(MODULE_BAIDU, f"将在 {delay} 秒后重试", 'warning'))
                        time.sleep(delay)
                        continue
                    return {"status": "error", "message": f"API请求失败，状态码: {status_code}"}
                
                # 解析JSON响应
                try:
                    result = response.json()
                except Exception as e:
                    print(format_log(MODULE_BAIDU, f"JSON解析错误: {str(e)}", 'error'))
                    if attempt < retry_count - 1:
                        delay = (attempt + 1) * 2
                        time.sleep(delay)
                        continue
                    return {"status": "error", "message": f"API响应解析失败: {str(e)}"}
                
                # 检查API响应
                if "error_code" in result:
                    error_code = result["error_code"]
                    error_message = self.ERROR_CODES.get(error_code, f"未知错误 (错误码: {error_code})")
                    print(format_log(MODULE_BAIDU, f"API错误: {error_message}", 'error'))
                    
                    # 判断是否可以重试
                    if error_code in ["54003", "52001", "52002"] and attempt < retry_count - 1:
                        delay = (attempt + 1) * 2
                        print(format_log(MODULE_BAIDU, f"将在 {delay} 秒后重试", 'warning'))
                        time.sleep(delay)
                        continue
                    
                    return {"status": "error", "message": error_message}
                
                # 处理成功响应
                if "trans_result" in result and result["trans_result"]:
                    translated_text = result["trans_result"][0]["dst"]
                    if self._debug:
                        print(format_log(MODULE_BAIDU, f"段落 #{self._paragraph_index} 翻译成功", 'success'))
                    return {"status": "success", "text": translated_text}
                
                # 未找到翻译结果
                print(format_log(MODULE_BAIDU, "API返回无效的响应", 'error'))
                if self._debug:
                    print(format_log(MODULE_BAIDU, f"响应内容: {result}", 'error'))
                return {"status": "error", "message": "API返回了无效的响应"}
                
            except Exception as e:
                print(format_log(MODULE_BAIDU, f"翻译时出错: {str(e)}", 'error'))
                if attempt < retry_count - 1:
                    delay = (attempt + 1) * 2
                    print(format_log(MODULE_BAIDU, f"将在 {delay} 秒后重试", 'warning'))
                    time.sleep(delay)
                else:
                    return {"status": "error", "message": f"翻译失败: {str(e)}"}
        
        return {"status": "error", "message": "超过最大重试次数"}
        
    def set_debug(self, debug=False):
        """设置是否输出详细调试信息"""
        self._debug = debug
        return self

    def set_paragraph_index(self, index):
        """设置段落索引"""
        self._paragraph_index = index
        return self

    def get_paragraph_index(self):
        """获取当前段落索引"""
        return self._paragraph_index

    def update_config(self, appid=None, appkey=None):
        """
        更新翻译器配置
        @param appid: 百度翻译AppID
        @param appkey: 百度翻译密钥
        """
        try:
            if appid is not None and appkey is not None:
                # 更新内存中的配置
                self.config["prompt_translate"]["appid"] = appid
                self.config["prompt_translate"]["key"] = appkey
                
                # 更新配置文件
                current_path = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
                config_path = os.path.join(current_path, "config.json")
                
                # 读取现有配置
                with open(config_path, "r", encoding="utf-8") as f:
                    full_config = json.load(f)
                
                # 更新翻译配置部分
                full_config["prompt_translate"]["appid"] = appid
                full_config["prompt_translate"]["key"] = appkey
                
                # 保存更新后的配置
                with open(config_path, "w", encoding="utf-8") as f:
                    json.dump(full_config, f, ensure_ascii=False, indent=2)
                
                if self._debug:
                    print(format_log(MODULE_BAIDU, "翻译器配置已更新", 'success'))
                return True
            
            return False
        except Exception as e:
            print(format_log(MODULE_BAIDU, f"更新翻译器配置时出错: {str(e)}", 'error'))
            return False

# 创建全局翻译器实例
translator = BaiduTranslator() 