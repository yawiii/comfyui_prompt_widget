import server
from aiohttp import web
import os
import json
from .translate_node import PromptWidget
from .llm_expand_node import LLMExpandNode
from .lib import Colors, MODULE_ROUTE, success, error, warning, info, content, format_log

# 日志控制
_debug = False

def log(*args, force=False):
    """有条件地打印日志"""
    if _debug or force:
        message = ' '.join(str(arg) for arg in args)
        print(f"{MODULE_ROUTE} {message}")

# 添加获取预设列表的路由
@server.PromptServer.instance.routes.get("/prompt_widget/presets")
async def get_presets(request):
    """
    处理预设列表请求
    返回预设列表的JSON数据
    """
    try:
        # 获取插件目录路径
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        preset_file = os.path.join(plugin_dir, "Prompt_Preset_List.json")
        
        log(f"请求预设文件: {preset_file}")
        
        # 检查文件是否存在
        if not os.path.exists(preset_file):
            log(error(f"预设文件不存在: {preset_file}"))
            return web.json_response({
                "status": "error",
                "message": "预设文件不存在"
            }, status=404)
        
        # 读取文件内容
        with open(preset_file, "r", encoding="utf-8") as f:
            presets_data = json.load(f)
        
        log(success(f"成功读取预设文件: 找到 {len(presets_data.get('presets', []))} 个预设"))
        
        # 返回JSON响应
        return web.json_response(presets_data)
        
    except Exception as e:
        log(error(f"读取预设文件时出错: {str(e)}"))
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

@server.PromptServer.instance.routes.post("/expand_text")
async def handle_expand_request(request):
    """
    处理前端发送的扩写请求
    接收JSON格式的请求体，包含text和node_id
    返回JSON格式的响应，包含扩写结果或错误信息
    """
    try:
        # 解析请求体
        data = await request.json()
        
        # 检查必要参数
        if "text" not in data:
            log(error("缺少必要参数: text"))
            return web.json_response({"success": False, "error": "缺少必要参数: text"}, status=400)
        
        text = data.get("text", "")
        node_id = data.get("node_id")
        
        # 请求唯一ID，用于日志跟踪
        import time
        request_id = f"{int(time.time() * 1000)}"[-6:]
        
        # 详细记录请求信息
        log(f"收到扩写请求，节点ID: {node_id}，请求ID：{request_id} ")
        
        # 记录原文内容，始终打印
        if _debug:
            log(f"{content(f'扩写文本: {text}')}")
        
        # 创建扩写节点实例
        expand_node = LLMExpandNode()
        
        # 调用扩写
        expanded_text = expand_node.expand_text(text)[0]
        
        # 检查返回的文本是否包含错误信息
        if "【扩写失败:" in expanded_text:
            # 提取错误信息
            error_message = expanded_text.split("【扩写失败:")[1].split("】")[0].strip()
            log(error(f"[{request_id}] 扩写失败: {error_message}"))
            return web.json_response({
                "success": False,
                "error": f"{error_message}"
            })
        elif expanded_text and expanded_text != text:
            # 使用绿色显示成功信息
            log(success(f"扩写成功，请求ID：[{request_id}]"))
            
            # 显示完整扩写结果
            if _debug:
                log(content(f"扩写结果: {expanded_text}"))
                
            return web.json_response({
                "success": True,
                "expanded_text": expanded_text
            })
        else:
            # 使用红色显示错误信息
            log(error(f"[{request_id}] 扩写失败: 未能生成新内容"), force=True)
            return web.json_response({
                "success": False,
                "error": "扩写失败：未能生成新内容"
            })
            
    except Exception as e:
        # 使用红色显示错误信息
        log(error(f"处理扩写请求时出错: {str(e)}"), force=True)
        import traceback
        tb = traceback.format_exc()
        log(error(f"错误详情:\n{tb}"), force=True)
        return web.json_response({
            "success": False,
            "error": f"{str(e)}"
        }, status=500)

@server.PromptServer.instance.routes.post("/prompt_translate")
async def handle_translate_request(request):
    """
    处理前端发送的翻译请求
    接收JSON格式的请求体，包含text和node_id
    返回JSON格式的响应，包含翻译结果或错误信息
    """
    try:
        # 解析请求体
        data = await request.json()
        
        # 检查必要参数
        if "text" not in data:
            log(error("缺少必要参数: text"))
            return web.json_response({"status": "error", "message": "缺少必要参数: text"}, status=400)
        
        text = data.get("text", "")
        node_id = data.get("node_id")
        from_lang = data.get("from_lang", "auto")
        to_lang = data.get("to_lang", "auto")
        
        # 请求唯一ID，用于日志跟踪
        import time
        request_id = f"{int(time.time() * 1000)}"[-6:]
        
        # 详细记录请求信息
        log(f"收到翻译请求，节点ID: {node_id}，请求ID：{request_id} ")
        log(f"请求参数: from_lang={from_lang}, to_lang={to_lang}")
        
        if _debug:
            # 避免打印太多内容，但需要显示完整内容
            log(f"{content(f'翻译文本: {text}')}")
        
        # 创建翻译节点实例
        prompt_node = PromptWidget()
        
        # 自动检测语言
        detected_to_lang = prompt_node.auto_detect_language(text, to_lang)
        
        # 调用翻译器进行翻译
        result = prompt_node.process_translation(
            text, 
            from_lang=from_lang, 
            to_lang=detected_to_lang, 
            node_id=node_id
        )
        
        if result["status"] == "success":
            # 使用绿色显示成功信息
            success_msg = "翻译成功"
            if result.get("from_cache"):
                success_msg += " (使用缓存)"
            log(success(f"{success_msg},请求ID：[{request_id}]"))
            
            # 显示完整翻译结果，使用棕色
            if _debug and "text" in result:
                log(content(f"翻译结果: {result['text']}"))
        else:
            # 使用红色显示错误信息
            log(error(f"[{request_id}] 翻译失败: {result.get('message')}", force=True))
            
        return web.json_response(result)
        
    except Exception as e:
        # 使用红色显示错误信息
        log(error(f"处理翻译请求时出错: {str(e)}"), force=True)
        import traceback
        tb = traceback.format_exc()
        log(error(f"错误详情:\n{tb}"), force=True)
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

@server.PromptServer.instance.routes.post("/prompt_widget/save_presets")
async def save_presets(request):
    """
    处理保存预设列表的请求
    接收JSON格式的请求体，包含presets数组
    将预设保存到JSON文件中
    """
    try:
        # 解析请求体
        data = await request.json()
        
        if "presets" not in data:
            log(error("缺少必要参数: presets"))
            return web.json_response({
                "status": "error",
                "message": "缺少必要参数: presets"
            }, status=400)
        
        presets = data["presets"]
        
        # 获取插件目录路径
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        preset_file = os.path.join(plugin_dir, "Prompt_Preset_List.json")
        
        log(f"正在保存预设到文件: {preset_file}")
        
        # 保存到文件
        with open(preset_file, "w", encoding="utf-8") as f:
            json.dump({"presets": presets}, f, ensure_ascii=False, indent=2)
        
        log(success(f"成功保存 {len(presets)} 个预设到文件"))
        
        return web.json_response({
            "status": "success",
            "message": "预设保存成功"
        })
        
    except Exception as e:
        log(error(f"保存预设文件时出错: {str(e)}"))
        import traceback
        tb = traceback.format_exc()
        log(error(f"错误详情:\n{tb}"))
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

@server.PromptServer.instance.routes.get("/prompt_widget/load_config")
async def load_config(request):
    """
    加载API配置
    返回配置的JSON数据
    """
    try:
        # 获取插件目录路径
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        config_file = os.path.join(plugin_dir, "config.json")
        
        log(f"请求配置文件: {config_file}")
        
        # 检查文件是否存在
        if not os.path.exists(config_file):
            # 如果文件不存在，返回默认配置
            default_config = {
                "prompt_translate": {
                    "appid": "",
                    "key": ""
                },
                "llm_expand": {
                    "api_key": "",
                    "api_base": "https://api.openai.com/v1",
                    "model": "gpt-3.5-turbo",
                    "temperature": 0.7,
                    "max_tokens": 1000,
                    "system_prompt": "你是一个专业的写作助手，擅长对文本进行扩写和润色。请对用户输入的文本进行扩写，使其更加丰富和生动。"
                }
            }
            
            # 创建默认配置文件
            with open(config_file, "w", encoding="utf-8") as f:
                json.dump(default_config, f, ensure_ascii=False, indent=2)
            
            log(success(f"创建默认配置文件: {config_file}"))
            return web.json_response(default_config)
        
        # 读取文件内容
        with open(config_file, "r", encoding="utf-8") as f:
            config_data = json.load(f)
        
        log(success(f"成功读取配置文件"))
        
        # 返回JSON响应
        return web.json_response(config_data)
        
    except Exception as e:
        log(error(f"读取配置文件时出错: {str(e)}"))
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

@server.PromptServer.instance.routes.post("/prompt_widget/save_config")
async def save_config(request):
    """
    保存API配置并通知相关节点更新
    接收JSON格式的请求体，包含配置数据
    """
    try:
        # 解析请求体
        data = await request.json()
        
        # 获取插件目录路径
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        config_file = os.path.join(plugin_dir, "config.json")
        
        log(f"正在保存配置到文件: {config_file}")
        
        # 保存到文件
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        log(success(f"成功保存配置到文件"))
        
        # 重新加载配置并通知节点
        reload_node_configs()
        
        return web.json_response({
            "status": "success",
            "message": "配置保存成功"
        })
        
    except Exception as e:
        log(error(f"保存配置文件时出错: {str(e)}"))
        import traceback
        tb = traceback.format_exc()
        log(error(f"错误详情:\n{tb}"))
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

def set_debug(debug=False):
    """设置调试模式"""
    global _debug
    _debug = debug
    # 同时设置翻译节点的调试模式
    from .translate_node import PromptWidget
    PromptWidget.set_debug(debug)
    # 设置LLM节点的调试模式
    from .llm_expand_node import LLMExpandNode
    if hasattr(LLMExpandNode, 'set_debug'):
        LLMExpandNode.set_debug(debug)
    return True

@server.PromptServer.instance.routes.post("/prompt_widget/set_debug")
async def set_debug_mode(request):
    """
    设置调试模式
    接收JSON格式的请求体，包含debug布尔值
    """
    try:
        # 解析请求体
        data = await request.json()
        
        if "debug" not in data:
            log(error("缺少必要参数: debug"))
            return web.json_response({
                "status": "error",
                "message": "缺少必要参数: debug"
            }, status=400)
        
        debug_mode = data["debug"]
        
        # 使用现有的set_debug函数设置调试模式
        set_debug(debug_mode)
        
        # 更新配置文件中的调试模式
        try:
            plugin_dir = os.path.dirname(os.path.abspath(__file__))
            init_file = os.path.join(plugin_dir, "__init__.py")
            
            with open(init_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
            
            # 查找并更新DEBUG_MODE的值
            for i, line in enumerate(lines):
                if line.strip().startswith("DEBUG_MODE = "):
                    lines[i] = f"DEBUG_MODE = {str(debug_mode)} \n"
                    break
            
            # 写回文件
            with open(init_file, "w", encoding="utf-8") as f:
                f.writelines(lines)
        except Exception as e:
            log(error(f"更新配置文件中的调试模式时出错: {str(e)}"))
            # 继续执行，因为内存中的调试模式已经更新
        
        # log(success(f"调试模式已{'启用' if debug_mode else '禁用'}"))
        
        return web.json_response({
            "status": "success",
            "message": f"调试模式已{'启用' if debug_mode else '禁用'}"
        })
        
    except Exception as e:
        log(error(f"设置调试模式时出错: {str(e)}"))
        return web.json_response({
            "status": "error",
            "message": str(e)
        }, status=500)

# 添加配置重新加载函数
def reload_node_configs():
    """
    重新加载节点配置
    通知所有相关节点更新其配置
    """
    try:
        # 获取插件目录路径
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        config_file = os.path.join(plugin_dir, "config.json")
        
        # 读取最新配置
        with open(config_file, "r", encoding="utf-8") as f:
            config_data = json.load(f)
            
        # 更新翻译节点配置
        PromptWidget.update_config(config_data.get("prompt_translate", {}))
        # 更新LLM节点配置
        LLMExpandNode.update_config(config_data.get("llm_expand", {}))
        
        # 发送WebSocket事件通知前端
        server.PromptServer.instance.send_sync("prompt_widget_config_update", {
            "status": "success",
            "message": "配置已更新",
            "config": config_data
        })
        
        log(success("节点配置已重新加载"))
        return True
    except Exception as e:
        log(error(f"重新加载配置时出错: {str(e)}"))
        return False 