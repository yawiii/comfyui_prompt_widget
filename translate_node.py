import server
import re
from .lib.baidutranslation import translator
from .lib import Colors, MODULE_PROMPT, success, error, warning, info, content, format_log
from .lib.cache import cache_manager

class PromptWidget:
    
    # 日志控制
    _debug = False
    
    # 记录上次翻译时间，防止频繁请求
    _last_translation_time = {}
    _min_translation_interval = 1.0  # 最小翻译间隔（秒）
    
    def __init__(self):
        # 保存节点ID的属性
        self.id = None
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"multiline": True}),
                "auto_translate": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "to_lang": (["auto", "en", "zh"], {"default": "auto"}),
                "_node_id": ("STRING", {"default": "", "hidden": True})  # 添加隐藏的节点ID输入
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "translate"
    CATEGORY = "text"
    
    @classmethod
    def set_debug(cls, debug=False):
        """设置调试模式"""
        cls._debug = debug
        # 同时设置翻译器的调试模式
        translator.set_debug(debug)
        return cls
    
    @classmethod
    def log(cls, *args, force=False):
        """有条件地打印日志"""
        if cls._debug or force:
            message = ' '.join(str(arg) for arg in args)
            print(f"{MODULE_PROMPT} {message}")
    
    @classmethod
    def _get_from_cache(cls, text):
        """从缓存中获取翻译结果"""
        if not text:
            return None
        result = cache_manager.get_translation_cache(text)
        if result:
            cls.log(success(f"缓存命中: '{text[:20]}...'"))
        return result
    
    @classmethod
    def _add_to_cache(cls, original_text, translated_text):
        """添加翻译结果到缓存"""
        if not original_text or not translated_text:
            return
            
        cache_manager.set_translation_cache(original_text, translated_text)
        cls.log(success(f"已添加到缓存"))
    
    @staticmethod
    def _clean_colon_spaces(text):
        """
        移除冒号右侧的空格
        只处理英文冒号和中文冒号
        """
        # 处理英文冒号和中文冒号后的空格
        text = re.sub(r'[:：]\s+', r':', text)
        return text
    
    @classmethod
    def _split_paragraphs(cls, text, max_length=2000):
        """
        按照段落（换行符）拆分文本，并保留所有信息
        每个段落作为一个单独的翻译单元
        返回一个包含段落和元数据的列表
        """
        if not text:
            return []
        
        # 按换行符分割文本
        paragraphs = []
        lines = text.split('\n')
        
        cls.log(f"拆分为 {len(lines)} 个段落")
        
        for i, line in enumerate(lines):
            # 如果单个段落超过最大长度，进一步拆分
            if len(line) > max_length:
                # 按句子结束符号分割长段落
                current_pos = 0
                sentence_enders = '.。!！?？;；'
                for j in range(max_length, len(line), max_length):
                    # 寻找合适的分割点
                    split_pos = j
                    for k in range(j, max(j-max_length//2, current_pos), -1):
                        if k < len(line) and line[k] in sentence_enders:
                            split_pos = k + 1
                            break
                    
                    # 添加子段落，并记录段落信息
                    sub_paragraph = line[current_pos:split_pos]
                    paragraphs.append({
                        "text": sub_paragraph,
                        "line_index": i,
                        "is_split": True,
                        "is_line_end": False
                    })
                    current_pos = split_pos
                
                # 添加最后一个子段落
                if current_pos < len(line):
                    paragraphs.append({
                        "text": line[current_pos:],
                        "line_index": i,
                        "is_split": True,
                        "is_line_end": True
                    })
            else:
                # 添加完整段落
                paragraphs.append({
                    "text": line,
                    "line_index": i,
                    "is_split": False,
                    "is_line_end": True
                })
        
        if cls._debug:
            for i, p in enumerate(paragraphs):
                cls.log(f"段落 {i+1}:  {len(p['text'])}个字符")
        
        return paragraphs
    
    def translate_paragraph(self, paragraph, from_lang, to_lang):
        """
        翻译单个段落
        支持重试，并返回翻译结果或错误信息
        """
        text = paragraph["text"]
        if not text.strip():
            # 空段落直接返回空字符串
            return {"status": "success", "text": "", "paragraph": paragraph}
        
        # 检查缓存
        cached_result = self._get_from_cache(text)
        if cached_result:
            self.log(success("使用缓存的翻译结果"))
            return {"status": "success", "text": cached_result, "paragraph": paragraph, "from_cache": True}
        
        # 调用百度翻译API前先获取段落在原文中的索引
        line_index = paragraph.get("line_index", 0)
        # 设置段落索引 (line_index+1 使索引从1开始)
        translator.set_paragraph_index(line_index + 1)
        
        # 调用百度翻译API
        result = translator.translate_text(text, from_lang=from_lang, to_lang=to_lang)
        
        # 处理翻译结果
        if result["status"] == "success":
            translated_text = result["text"]
            # 处理冒号后的空格
            translated_text = self._clean_colon_spaces(translated_text)
            
            # 添加到缓存
            self._add_to_cache(text, translated_text)
            
            # 使用绿色显示成功信息，棕色显示翻译内容
            if self._debug:
                self.log(success("翻译成功"))
            
            return {"status": "success", "text": translated_text, "paragraph": paragraph}
        else:
            # 使用红色显示错误信息
            self.log(error(f"翻译失败: {result['message']}"), force=True)
            return {"status": "error", "message": result["message"], "paragraph": paragraph}
    
    def should_throttle(self, node_id, text):
        """检查是否应该限制翻译频率"""
        import time
        
        current_time = time.time()
        last_time = self._last_translation_time.get(node_id, 0)
        last_text = getattr(self, '_last_text', {}).get(node_id, '')
        
        # 如果是相同文本且时间间隔过短，则限制请求
        if text == last_text and current_time - last_time < self._min_translation_interval:
            self.log(warning(f"节点 {node_id} 的请求过于频繁，忽略"), force=True)
            return True
            
        # 更新时间和文本记录
        self._last_translation_time[node_id] = current_time
        if not hasattr(self, '_last_text'):
            self._last_text = {}
        self._last_text[node_id] = text
        
        return False
    
    def process_translation(self, text, from_lang="auto", to_lang="auto", node_id=None):
        """执行翻译，逐段翻译并保留原始格式"""
        if not text.strip():
            return {"status": "error", "message": "翻译文本为空"}
        
        # 限制请求频率
        if node_id and self.should_throttle(node_id, text):
            return {"status": "error", "message": "请求过于频繁，请稍后再试"}
        
        # 保留原始文本
        original_text = text
        
        # 检查当前文本在缓存中是否存在
        cached_result = self._get_from_cache(text)
        if cached_result:
            # 确保实例历史记录存在
            if node_id:
                cache_manager.init_history(node_id)
                cache_manager.record_history(node_id, text)
            
            # 确定当前操作是恢复原文还是恢复译文
            operation_desc = "恢复译文" if text == original_text else "恢复原文"
            
            self.log(success(f"从缓存中{operation_desc}"))
            
            if node_id:
                server.PromptServer.instance.send_sync(
                    "prompt_translate_update",
                    {
                        "node_id": node_id,
                        "status": "success",
                        "original_text": text,
                        "translated_text": cached_result,
                        "operation_type": "restore",
                        "operation_desc": operation_desc
                    }
                )
                
            return {"status": "success", "text": cached_result, "from_cache": True, "operation_desc": operation_desc}
        
        # 详细输出原始文本信息
        self.log("包含: {} 字符，{} 个换行符".format(len(text), text.count('\n')))
        
        # 按段落拆分文本
        paragraphs = self._split_paragraphs(original_text, max_length=2000)
        if not paragraphs:
            return {"status": "error", "message": "文本分段后为空"}
        
        # 发送翻译开始通知
        if node_id:
            server.PromptServer.instance.send_sync(
                "prompt_translate_update",
                {
                    "node_id": node_id, 
                    "progress": {
                        "current": 0, 
                        "total": len(paragraphs)
                    },
                    "status": "translating",
                    "operation_type": "translate"
                }
            )
        
        # 逐段翻译
        translated_paragraphs = []
        all_from_cache = True  # 标记是否所有段落都来自缓存
        
        for i, paragraph in enumerate(paragraphs):
            # 发送进度通知
            if node_id:
                server.PromptServer.instance.send_sync(
                    "prompt_translate_update",
                    {
                        "node_id": node_id, 
                        "progress": {
                            "current": i + 1, 
                            "total": len(paragraphs)
                        },
                        "status": "translating",
                        "operation_type": "translate"
                    }
                )
            
            # 翻译段落
            result = self.translate_paragraph(paragraph, from_lang, to_lang)
            
            # 检查是否使用了缓存
            if result.get("from_cache") is not True:
                all_from_cache = False
            
            # 处理翻译结果
            if result["status"] == "success":
                translated_paragraphs.append(result)
            else:
                # 翻译失败，通知客户端
                if node_id:
                    server.PromptServer.instance.send_sync(
                        "prompt_translate_update",
                        {
                            "node_id": node_id,
                            "status": "error",
                            "message": result["message"]
                        }
                    )
                return {"status": "error", "message": result["message"]}
        
        # 重建文本，保留原始换行格式
        lines = [""] * (max(p["paragraph"]["line_index"] for p in translated_paragraphs) + 1)
        
        for result in translated_paragraphs:
            paragraph = result["paragraph"]
            line_index = paragraph["line_index"]
            
            # 处理被分割的段落
            if paragraph["is_split"]:
                if paragraph["is_line_end"]:
                    lines[line_index] += result["text"]
                else:
                    lines[line_index] += result["text"] + " "
            else:
                lines[line_index] = result["text"]
        
        # 合并所有行
        final_text = "\n".join(lines)
        
        self.log("翻译完成，结果字符数: {}，{} 个换行符".format(len(final_text), final_text.count('\n')))
        
        # 添加到缓存
        if not all_from_cache:
            self._add_to_cache(original_text, final_text)
        
        # 检测翻译后的文本语言特征，确定翻译方向
        chinese_chars_original = sum(1 for char in original_text if '\u4e00' <= char <= '\u9fff')
        chinese_chars_final = sum(1 for char in final_text if '\u4e00' <= char <= '\u9fff')
        
        is_chinese_original = chinese_chars_original / len(original_text) > 0.2 if len(original_text) > 0 else False
        is_chinese_final = chinese_chars_final / len(final_text) > 0.2 if len(final_text) > 0 else False
        
        # 确定翻译方向
        if is_chinese_original and not is_chinese_final:
            translate_direction = "中译英"
        elif not is_chinese_original and is_chinese_final:
            translate_direction = "英译中"
        else:
            translate_direction = "翻译"
        
        # 记录此次翻译的原文，即发送给后端进行翻译的文本
        if node_id:
            cache_manager.init_history(node_id)
            cache_manager.record_history(node_id, original_text)
        
        # 发送成功通知
        if node_id:
            server.PromptServer.instance.send_sync(
                "prompt_translate_update",
                {
                    "node_id": node_id,
                    "status": "success",
                    "original_text": original_text,
                    "translated_text": final_text,
                    "operation_type": "translate",
                    "translate_direction": translate_direction,
                    "from_cache": all_from_cache
                }
            )
        
        return {"status": "success", "text": final_text, "from_cache": all_from_cache, "translate_direction": translate_direction}
    
    def auto_detect_language(self, text, to_lang="auto"):
        """自动检测语言"""
        if to_lang == "auto":
            chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
            is_chinese = chinese_chars / len(text) > 0.2 if len(text) > 0 else False
            to_lang = "en" if is_chinese else "zh"
        
        self.log(f"目标语言: {to_lang}")
        return to_lang
    
    def translate(self, text, auto_translate=True, to_lang="auto", _node_id=""):
        """执行翻译"""
        if not text.strip():
            return (text,)
        
        if not auto_translate:
            return (text,)
        
        # 检查原始文本中的换行符
        newline_count = text.count('\n')
        self.log(f"收到文本，包含{newline_count}个换行符")
        
        # 自动检测语言
        detected_to_lang = self.auto_detect_language(text, to_lang)
        
        # 调用翻译方法并返回结果
        result = self.process_translation(text, from_lang="auto", to_lang=detected_to_lang, node_id=_node_id)
        
        # 检查翻译结果
        if result["status"] == "success":
            result_newlines = result["text"].count('\n')
            self.log(success("翻译结果包含{}个换行符".format(result_newlines)))
            return (result["text"],)
        else:
            self.log(error("翻译失败: {}".format(result.get('message', '未知错误'))), force=True)
            return (text,)
    
    @classmethod
    def update_config(cls, config):
        """
        更新节点配置
        @param config: 新的配置字典
        """
        try:
            if not config:
                return False
                
            # 更新百度翻译配置
            if "appid" in config and "key" in config:
                # 更新翻译器配置
                translator.update_config(
                    appid=config["appid"],
                    appkey=config["key"]
                )
                
                # 更新类属性（用于新实例化的对象）
                cls.BAIDU_APP_ID = config["appid"]
                cls.BAIDU_APP_KEY = config["key"]
                
                # 清空翻译缓存，确保使用新配置
                if hasattr(cache_manager, 'clear_translation_cache'):
                    cache_manager.clear_translation_cache()
                
                # 清空节流记录
                cls._last_translation_time = {}
                if hasattr(cls, '_last_text'):
                    cls._last_text = {}
                
                cls.log(success("翻译配置已更新"))
                return True
            
            return False
        except Exception as e:
            # 只在真正出错时才输出错误日志
            if str(e) != "'CacheManager' object has no attribute 'clear_translation_cache'":
                cls.log(error(f"更新翻译节点配置时出错: {str(e)}"))
            return False 