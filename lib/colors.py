"""
颜色模块 - 为日志输出提供颜色支持
"""

class Colors:
    """ANSI颜色代码常量"""
    # 基本颜色
    RESET = "\033[0m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    PURPLE = "\033[95m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    
    # 增强颜色
    LIGHT_GREEN = "\033[92;1m"  # 浅绿色
    LIGHT_BLUE = "\033[94;1m"   # 浅蓝色
    LIGHT_YELLOW = "\033[93;1m" # 浅黄色
    BROWN = "\033[33m"          # 棕色/褐色

# 模块前缀
MODULE_BAIDU = f"{Colors.LIGHT_YELLOW}[BaiduTranslator]{Colors.RESET}"
MODULE_PROMPT = f"{Colors.LIGHT_BLUE}[PromptWidget]{Colors.RESET}"
MODULE_ROUTE = f"{Colors.PURPLE}[PromptWidget-Route]{Colors.RESET}"

# 状态颜色函数
def success(text):
    """将文本包装为成功颜色（绿色）"""
    return f"{Colors.GREEN}{text}{Colors.RESET}"

def error(text):
    """将文本包装为错误颜色（红色）"""
    return f"{Colors.RED}{text}{Colors.RESET}"

def warning(text):
    """将文本包装为警告颜色（黄色）"""
    return f"{Colors.YELLOW}{text}{Colors.RESET}"

def info(text):
    """将文本包装为信息颜色（蓝色）"""
    return f"{Colors.BLUE}{text}{Colors.RESET}"

def highlight(text):
    """将文本包装为高亮颜色（紫色）"""
    return f"{Colors.PURPLE}{text}{Colors.RESET}"

def content(text):
    """将文本包装为内容颜色（棕色）"""
    return f"{Colors.BROWN}{text}{Colors.RESET}"

# 格式化日志函数
def format_log(module, message, status=None):
    """根据状态格式化日志消息
    
    参数:
        module: 模块前缀常量
        message: 日志消息
        status: 可选状态类型，可以是 'success', 'error', 'warning', 'info', 'content'
    
    返回:
        格式化后的日志字符串
    """
    if status == 'success':
        message = success(message)
    elif status == 'error':
        message = error(message)
    elif status == 'warning':
        message = warning(message)
    elif status == 'info':
        message = info(message)
    elif status == 'content':
        message = content(message)
    
    return f"{module} {message}" 