import os
from .lib import Colors, success, error, warning, info, content, format_log
from .lib import MODULE_BAIDU, MODULE_PROMPT, MODULE_ROUTE
# 导入路由处理模块
from . import routes
# 导入节点类
from .translate_node import PromptWidget
from .llm_expand_node import LLMExpandNode



# 初始化调试模式（默认关闭）
routes.set_debug(False)


# # 注册节点
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 设置Web目录
WEB_DIRECTORY = "./web"

# 打印节点注册信息
print(f"{MODULE_PROMPT} {success('✨提示词小部件PromptWidget 已注册')}")