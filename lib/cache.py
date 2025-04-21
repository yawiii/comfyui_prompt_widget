import json
import os
from typing import Dict, Any, Optional
from datetime import datetime

class CacheManager:
    """通用缓存管理器，用于管理各种操作的缓存"""
    
    def __init__(self, cache_dir: str = "cache"):
        self.cache_dir = cache_dir
        self._ensure_cache_dir()
        self._memory_cache: Dict[str, Any] = {}
        self._history_cache: Dict[str, Dict] = {}
        
    def _ensure_cache_dir(self):
        """确保缓存目录存在"""
        if not os.path.exists(self.cache_dir):
            os.makedirs(self.cache_dir)
            
    def _get_cache_file_path(self, cache_type: str) -> str:
        """获取缓存文件路径"""
        return os.path.join(self.cache_dir, f"{cache_type}_cache.json")
    
    def load_cache(self, cache_type: str) -> Dict:
        """从文件加载缓存"""
        cache_file = self._get_cache_file_path(cache_type)
        if os.path.exists(cache_file):
            try:
                with open(cache_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"加载缓存文件失败: {e}")
        return {}
    
    def save_cache(self, cache_type: str, data: Dict):
        """保存缓存到文件"""
        cache_file = self._get_cache_file_path(cache_type)
        try:
            with open(cache_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存缓存文件失败: {e}")
    
    def get_translation_cache(self, text: str) -> Optional[str]:
        """获取翻译缓存"""
        return self._memory_cache.get(text)
    
    def set_translation_cache(self, text: str, translated_text: str):
        """设置翻译缓存"""
        self._memory_cache[text] = translated_text
        self._memory_cache[translated_text] = text  # 双向缓存
    
    def init_history(self, node_id: str):
        """初始化节点的历史记录"""
        if node_id not in self._history_cache:
            self._history_cache[node_id] = {
                "past": [],
                "future": [],
                "current": "",
                "last_update": datetime.now().isoformat()
            }
    
    def record_history(self, node_id: str, text: str):
        """记录历史"""
        self.init_history(node_id)
        history = self._history_cache[node_id]
        
        if history["current"] == text:
            return
            
        if text in history["past"]:
            return
            
        history["past"].append(history["current"])
        history["current"] = text
        history["future"] = []
        history["last_update"] = datetime.now().isoformat()
        
        # 限制历史记录长度
        if len(history["past"]) > 20:
            history["past"].pop(0)
    
    def undo(self, node_id: str) -> Optional[str]:
        """撤销操作"""
        history = self._history_cache.get(node_id)
        if not history or not history["past"]:
            return None
            
        current = history["current"]
        history["future"].append(current)
        history["current"] = history["past"].pop()
        history["last_update"] = datetime.now().isoformat()
        return history["current"]
    
    def redo(self, node_id: str) -> Optional[str]:
        """重做操作"""
        history = self._history_cache.get(node_id)
        if not history or not history["future"]:
            return None
            
        current = history["current"]
        history["past"].append(current)
        history["current"] = history["future"].pop()
        history["last_update"] = datetime.now().isoformat()
        return history["current"]
    
    def clear_history(self, node_id: str):
        """清空历史记录"""
        if node_id in self._history_cache:
            self._history_cache[node_id] = {
                "past": [],
                "future": [],
                "current": "",
                "last_update": datetime.now().isoformat()
            }
    
    def get_history(self, node_id: str) -> Dict:
        """获取历史记录"""
        return self._history_cache.get(node_id, {
            "past": [],
            "future": [],
            "current": "",
            "last_update": datetime.now().isoformat()
        })
    
    def has_history(self, node_id: str) -> bool:
        """检查是否有历史记录"""
        history = self._history_cache.get(node_id)
        return bool(history and (history["past"] or history["future"]))
    
    def cleanup_old_cache(self, max_age_hours: int = 24):
        """清理过期的缓存"""
        current_time = datetime.now()
        for node_id, history in list(self._history_cache.items()):
            last_update = datetime.fromisoformat(history["last_update"])
            if (current_time - last_update).total_seconds() > max_age_hours * 3600:
                del self._history_cache[node_id]

# 创建全局缓存管理器实例
cache_manager = CacheManager() 