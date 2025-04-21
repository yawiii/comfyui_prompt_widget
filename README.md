# ComfyUI Prompt Widget

一个强大的 ComfyUI 提示词处理扩展，提供提示词翻译和智能扩展功能。

## ✨ 功能特性

- 🌐 多语言翻译支持
  - 自动语言检测
  - 中英文互译
  - 智能分段翻译
  - 翻译缓存机制
  - 防频繁请求保护

- 🤖 LLM 智能扩展
  - 支持多种 LLM API
  - 智能提示词扩展
  - 可配置的扩展参数
  - 结果缓存优化

## 🚀 主要功能

### 1. 智能翻译
- 支持中英文双向翻译
- 自动检测输入语言
- 智能分段处理长文本
- 内置翻译缓存，提高响应速度
- 防频繁请求保护机制
- 支持批量翻译处理

### 2. 提示词扩写
- 基于 LLM 的智能扩写
- 支持多种 LLM API（如智谱 AI）
- 自动优化提示词结构
- 保持语义一致性
- 支持自定义扩写参数
- 结果缓存优化

### 3. 提示词预设
- 支持保存常用提示词
- 预设分类管理
- 快速导入导出
- 支持预设模板
- 预设搜索功能
- 预设版本管理

### 4. 历史记录
- 自动保存操作历史
- 支持历史记录搜索
- 历史记录分类
- 支持历史记录导出
- 历史记录清理
- 历史记录恢复

### 5. 编辑功能
- 支持撤销/重做操作
- 文本格式化
- 批量编辑
- 快捷键支持
- 自动保存
- 编辑历史记录

## 📦 安装方法

1. 进入 ComfyUI 的 `custom_nodes` 目录
```bash
cd ComfyUI/custom_nodes
```

2. 克隆仓库
```bash
git clone https://github.com/your-username/comfyui_prompt_widget.git
```

3. 安装依赖
```bash
cd comfyui_prompt_widget
pip install -r requirements.txt
```

4. 重启 ComfyUI

## ⚙️ 配置说明

### 翻译功能配置

在 `config.json` 中配置百度翻译 API：

```json
{
    "baidu_translate": {
        "app_id": "你的APP ID",
        "app_key": "你的密钥"
    }
}
```

### LLM 扩展配置

在 `config.json` 中配置 LLM API：

```json
{
    "llm": {
        "api_type": "zhipu",  // 或其他支持的 API 类型
        "api_key": "你的API密钥",
        "api_base": "API基础URL"
    }
}
```

## 🎮 使用方法


