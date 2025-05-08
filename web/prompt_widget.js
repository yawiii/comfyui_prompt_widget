
import { app } from "../../../scripts/app.js";
import { $el } from "../../../scripts/ui.js";
import { api } from "../../../scripts/api.js";

const EXTENSION_NAME = "ComfyUI.PromptWidget";

const EXTENSION_VERSION = "1.0.1";


let DEBUG = false;
const FEATURES = {
    enabled: true,
    history: true,
    preset: true,
    expand: true,
    translate: true,

    areAllFeaturesDisabled() {
        return !this.history && !this.preset && !this.expand && !this.translate;
    },


    updateEnabledState() {
        const allDisabled = this.areAllFeaturesDisabled();
        if (allDisabled && this.enabled) {

            this.enabled = false;

            const enabledSetting = app.ui.settings.getSettingValue("PromptWidget.Features.Enabled");
            if (enabledSetting) {
                app.ui.settings.setSettingValue("PromptWidget.Features.Enabled", false);
            }

            TranslateManager.cleanup();
            logger.log("所有功能已禁用，自动关闭小部件总开关");
        }
    }
};



const THROTTLE = {

    minInterval: 1000,
    lastRequestTime: {},
    lastRequestText: {},


    shouldThrottle(nodeId, text) {
        const now = Date.now();
        const lastTime = this.lastRequestTime[nodeId] || 0;
        const lastText = this.lastRequestText[nodeId] || '';


        if (text === lastText && now - lastTime < this.minInterval) {
            logger.warn(`节点 ${nodeId} 请求过于频繁，已自动节流`);
            return true;
        }


        this.lastRequestTime[nodeId] = now;
        this.lastRequestText[nodeId] = text;
        return false;
    }
};




const logger = {
    printedMessages: new Set(),


    log: (...args) => {
        if (!FEATURES.enabled) return;
        const message = args.join(' ');
        if (DEBUG && !logger.printedMessages.has(message)) {
            console.log("[PromptWidget]", ...args);
            logger.printedMessages.add(message);
        }
    },


    warn: (...args) => {
        if (!FEATURES.enabled) return;
        console.warn("[PromptWidget]", ...args);
    },


    error: (...args) => {
        if (!FEATURES.enabled) return;
        console.error("[PromptWidget]", ...args);
    },


    info: (...args) => {
        if (!FEATURES.enabled) return;
        if (DEBUG) {
            console.info("[PromptWidget]", ...args);
        }
    }
};


function debounce(func, wait = 100) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}



const DOMUtils = {

    domCache: new Map(),


    getCachedElement(selector, parent = document) {
        const cacheKey = `${parent === document ? 'doc' : parent.id || 'custom'}_${selector}`;
        if (!this.domCache.has(cacheKey)) {
            this.domCache.set(cacheKey, parent.querySelector(selector));
        }
        return this.domCache.get(cacheKey);
    },


    getCachedElements(selector, parent = document) {
        const cacheKey = `${parent === document ? 'doc' : parent.id || 'custom'}_all_${selector}`;
        if (!this.domCache.has(cacheKey)) {
            this.domCache.set(cacheKey, Array.from(parent.querySelectorAll(selector)));
        }
        return this.domCache.get(cacheKey);
    },


    clearCache() {
        this.domCache.clear();
    },


    removeElement(element) {
        try {
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
                return true;
            }
            return false;
        } catch (error) {
            console.error("移除元素时出错:", error);
        return false;
        }
    },


    removeElementsBySelector(selector, filterFn = null) {
        try {
            const elements = document.querySelectorAll(selector);
            if (elements.length === 0) return 0;

            let removed = 0;
            elements.forEach(element => {
                if (!filterFn || filterFn(element)) {
                    if (this.removeElement(element)) {
                        removed++;
                    }
                }
            });

            return removed;
        } catch (error) {
            logger.error(`移除选择器 ${selector} 匹配的元素时出错:`, error);
            return 0;
        }
    },


    removeElementsBySelectors(selectors, filterFn = null) {
        if (!selectors || !Array.isArray(selectors)) return 0;

        let totalRemoved = 0;
        selectors.forEach(selector => {
            totalRemoved += this.removeElementsBySelector(selector, filterFn);
        });

        return totalRemoved;
    },


    batchCleanup(selectors = [], clearCacheAfter = true) {
        let totalRemoved = 0;

        selectors.forEach(selector => {
            const removed = this.removeElementsBySelector(selector);
            totalRemoved += removed;
        });


        if (clearCacheAfter) {
            this.clearCache();
        }

        return totalRemoved;
    }
};


function addStylesheet() {

    if (document.getElementById("clip-translate-styles")) {
        return;
    }


    const link = document.createElement("link");
    link.id = "clip-translate-styles";
    link.rel = "stylesheet";
    link.type = "text/css";


    const scriptPath = import.meta.url;
    const cssPath = scriptPath.replace('prompt_widget.js', 'style.css');
    link.href = cssPath;


    document.head.appendChild(link);

    return link;
}


const TranslateManager = {
    instances: new Map(),
    history: new Map(),
    activeHistoryPopup: null,
    activePresetPopup: null,
    translationCache: new Map(),
    presets: null,


    socket: null,
    socketInitialized: false,


    statusTips: null,




    setupWebSocket() {
        if (this.socketInitialized) return;

        try {

            api.addEventListener("prompt_translate_update", (data) => {
                this.handleTranslationUpdate(data);
            });


            api.addEventListener("prompt_widget_config_update", (data) => {
                this.handleConfigUpdate(data);
            });

            this.socketInitialized = true;
            logger.info("WebSocket监听已初始化");
        } catch (error) {
            logger.error("WebSocket初始化失败:", error);
        }
    },


    handleTranslationUpdate(data) {
        try {
            logger.info("收到翻译更新:", data);

            const { node_id, status, translated_text, original_text, message, progress, operation_type, operation_desc, translate_direction } = data;
            if (!node_id) return;


            const instance = this.getInstance(node_id);
            if (!instance) {
                logger.warn(`无法找到节点 ${node_id} 的实例`);
                return;
            }


            const statusElement = instance.buttons?.translate || instance.text_element;


            if (status === "translating" && progress) {
                const { current, total } = progress;
                if (instance.text_element) {

                    this.showStatusTip(statusElement, 'loading', `翻译中 ${current}/${total}...`);
                }
                return;
            }


            if (status === "error" && message) {
                logger.error(`翻译错误: ${message}`);
                if (instance.text_element) {
                    this.showStatusTip(statusElement, 'error', message);
                }


                if (instance.buttons?.translate) {
                    instance.buttons.translate.classList.remove('widget_button_loading');
                }
                return;
            }


            if (status === "success" && translated_text && original_text) {

            this.translationCache.set(original_text, translated_text);
                this.translationCache.set(translated_text, original_text);

                if (instance.text_element) {

                this.updateTextValue(instance.text_element, translated_text);


                this.recordHistory(node_id, translated_text);


                this.showEffect(instance.text_element, 'prompt_text_updated');


                    if (operation_type === "restore") {

                        this.showStatusTip(statusElement, 'restore', operation_desc || "已恢复");


                        if (operation_desc === "恢复原文") {
                            instance.originalText = translated_text;
                        }

                    } else if (translate_direction) {

                        instance.originalText = original_text;


                        const cacheMsg = data.from_cache ? '(缓存)' : '';
                        this.showStatusTip(statusElement, 'success', `${translate_direction}完成${cacheMsg}`);
                    } else {

                        instance.originalText = original_text;


                        this.showStatusTip(statusElement, 'success', '翻译完成');
                    }
                }


                if (instance.buttons?.translate) {
                    instance.buttons.translate.classList.remove('widget_button_loading');
                }
            }
        } catch (error) {
            logger.error("处理翻译更新事件失败:", error);
        }
    },


    handleConfigUpdate(data) {
        try {
            logger.info("收到配置更新:", data);

            if (data.status === "success") {

                if (data.config) {

                    this.reloadConfig();


                    showSuccessToast("配置已更新");
                }
            } else {

            }
        } catch (error) {
            logger.error("处理配置更新事件失败:", error);
        }
    },




    async callBaiduTranslateAPI(text, nodeId, from_lang = "auto", to_lang = "auto") {
        try {
            if (!text || !text.trim()) {
                return { status: "error", message: "翻译文本为空" };
            }


            if (THROTTLE.shouldThrottle(nodeId, text)) {
                return { status: "error", message: "请求过于频繁，请稍后再试" };
            }


            if (DEBUG) {
                logger.info(`发送文本到API，长度: ${text.length}字符, 节点ID: ${nodeId}`);
            }


            const response = await api.fetchApi("/prompt_translate", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: text,
                    node_id: nodeId,
                    from_lang: from_lang,
                    to_lang: to_lang
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            if (DEBUG) {

                const resultPreview = JSON.stringify(result).substring(0, 100);
                logger.info(`API响应: ${resultPreview}...`);
            }
            return result;
        } catch (error) {
            logger.error("调用百度翻译API失败:", error);
            return { status: "error", message: `翻译请求失败: ${error.message}` };
        }
    },


    isNodeExists(nodeId) {
        if (!nodeId) return false;

        try {

            if (!app.graph) return false;


            if (app.graph.getNodeById) {
                return !!app.graph.getNodeById(nodeId);
            }


            if (app.graph._nodes_by_id && app.graph._nodes_by_id[nodeId] !== undefined) {
                return true;
            }

            if (app.graph.nodes) {
                return app.graph.nodes.some(node => node.id === nodeId);
            }

            return false;
        } catch (error) {
            logger.error(`检查节点 ${nodeId} 存在性时出错:`, error);
            return false;
        }
    },




    initOrClearHistory(nodeId, shouldClear = false) {
        if (!nodeId) return false;

        try {
            const key = String(nodeId);

            if (!this.history.has(key) || shouldClear) {
                this.history.set(key, {
                past: [],
                future: [],
                    current: shouldClear ? "" : this.history.get(key)?.current || ""
            });
        }

        if (shouldClear) {

                this.closeHistoryPopup();
            this.updateButtonStates(nodeId);
            logger.log(`已${shouldClear ? '清空' : '初始化'}节点 ${nodeId} 的历史记录`);
        }

        return true;
        } catch (error) {
            logger.error(`初始化或清空节点 ${nodeId} 的历史记录时出错:`, error);
            return false;
        }
    },


    recordHistory(nodeId, text) {
        if (!nodeId) return;

        try {
        this.initOrClearHistory(nodeId);
            const key = String(nodeId);
            const history = this.history.get(key);

            if (!history) return;


        if (history.current === text) return;


            if (history.past.includes(text)) {

                return;
            }


        history.past.push(history.current);
        history.current = text;
        history.future = [];


        if (history.past.length > 20) {
            history.past.shift();
        }


        this.updateButtonStates(nodeId);
        } catch (error) {
            logger.error(`记录节点 ${nodeId} 的历史时出错:`, error);
        }
    },


    clearHistory(nodeId) {
        return this.initOrClearHistory(nodeId, true);
    },


    updateButtonStates(nodeId) {
        if (!nodeId || !FEATURES.enabled || !FEATURES.history) return;

        try {

            const key = String(nodeId);


            const instance = this.getInstance(key);
        if (!instance?.buttons) return;


            const history = this.history.get(key);
        if (!history) return;


            const hasPast = history.past && history.past.length > 0;
            const hasFuture = history.future && history.future.length > 0;


        const buttonStates = {
                undo: hasPast,
                redo: hasFuture,
                history: true
        };


        Object.entries(buttonStates).forEach(([key, enabled]) => {
            const button = instance.buttons[key];
            if (button) {
                    if (enabled) {
                        button.classList.remove('widget_button_disabled');
                        button.disabled = false;
                    } else {
                        button.classList.add('widget_button_disabled');
                        button.disabled = true;
                    }
                }
            });
        } catch (error) {
            logger.error(`更新节点 ${nodeId} 的按钮状态时出错:`, error);
        }
    },




    addHoverEffect(element, config = {}) {
        const defaultConfig = {
            scale: 1.1,
            opacity: 1,
            color: null,
            backgroundColor: null
        };

        const finalConfig = { ...defaultConfig, ...config };

        element.addEventListener("mouseenter", () => {
            element.style.opacity = String(finalConfig.opacity);
            element.style.transform = `scale(${finalConfig.scale})`;
            if (finalConfig.color) element.style.color = finalConfig.color;
            if (finalConfig.backgroundColor) element.style.backgroundColor = finalConfig.backgroundColor;
        });

        element.addEventListener("mouseleave", () => {
            element.style.opacity = "0.8";
            element.style.transform = "scale(1)";
            if (finalConfig.color) element.style.color = "rgba(255, 255, 255, 0.6)";
            if (finalConfig.backgroundColor) element.style.backgroundColor = "transparent";
        });
    },


    safeRemoveElement(element) {
        return DOMUtils.removeElement(element);
    },


    cleanup(nodeId = null) {

        if (nodeId !== null && !FEATURES.enabled) return;


        this.closeHistoryPopup();
        this.closePresetPopup();


        if (nodeId) {
            const instance = this.getInstance(nodeId);
            if (instance) {

                if (instance.text_element && instance.blurHandler) {
                    instance.text_element.removeEventListener("blur", instance.blurHandler);
                }


                this.safeRemoveElement(instance.element);


                this.instances.delete(nodeId);
            }
            return;
        }


        for (const [instanceNodeId, instance] of this.instances) {

            if (instance.text_element && instance.blurHandler) {
                instance.text_element.removeEventListener("blur", instance.blurHandler);
            }


            this.safeRemoveElement(instance.element);
        }


        this.instances.clear();
    },


    addInstance(nodeId, widget) {

        if (!FEATURES.enabled) return;

        if (!nodeId || !widget) return;

        try {
            const key = String(nodeId);


            if (this.instances.has(key)) {
            this.cleanup(nodeId);
        }

            this.instances.set(key, widget);


        if (widget.text_element) {
            this.initOrClearHistory(nodeId);
            this.recordHistory(nodeId, widget.text_element.value || "");
        }
        } catch (error) {

        }
    },


    hasInstance(nodeId) {
        if (nodeId == null) return false;
        try {
            return this.instances.has(String(nodeId));
        } catch (error) {
            logger.error(`检查节点 ${nodeId} 的实例是否存在时出错:`, error);
            return false;
        }
    },


    isEmptyInstance(nodeId) {
        if (nodeId == null) return true;

        try {
            const key = String(nodeId);

            if (!this.instances.has(key)) return true;


            const history = this.history.get(key);
            if (!history) return true;


            const isEmpty = (!history.current || history.current === '') &&
                           (!history.past || history.past.length === 0) &&
                           (!history.future || history.future.length === 0);

            return isEmpty;
        } catch (error) {
            logger.error(`检查节点 ${nodeId} 的实例是否为空时出错:`, error);
            return true;
        }
    },


    cleanupEmptyInstances(trigger = 'timer') {

        if (!FEATURES.enabled) return 0;

        let cleanedCount = 0;
        try {

            const nodeIds = Array.from(this.instances.keys());


            for (const nodeId of nodeIds) {

                const nodeExists = this.isNodeExists(nodeId);


                const history = this.history.get(nodeId);
                const hasHistory = history && (
                    (history.current && history.current.trim() !== '') ||
                    (history.past && history.past.length > 0) ||
                    (history.future && history.future.length > 0)
                );


                if (!nodeExists && !hasHistory) {
                    this.cleanup(nodeId);
                    cleanedCount++;
                    continue;
                }


                if (nodeExists && this.isEmptyInstance(nodeId) && !hasHistory) {
                    this.cleanup(nodeId);
                    cleanedCount++;
                }
            }


            const remainingCount = this.instances.size;


            if (trigger === 'timer') {
                logger.info(`[定时清理] 已清理 ${cleanedCount} 个空实例（不包含有历史记录的实例），当前剩余 ${remainingCount} 个实例`);
            } else if (trigger === 'nodeDelete') {
                logger.info(`[节点删除] 已清理 ${cleanedCount} 个空实例（不包含有历史记录的实例），当前剩余 ${remainingCount} 个实例`);
            }

            return cleanedCount;
        } catch (error) {
            logger.error(`清理空实例时出错: ${error.message}`);
            return cleanedCount;
        }
    },


    getInstance(nodeId) {
        if (nodeId == null) return null;

        try {

            const key = String(nodeId);
            return this.instances.get(key);
        } catch (error) {
            logger.error(`获取节点 ${nodeId} 的实例时出错:`, error);
            return null;
        }
    },




    executeAction(nodeId, actionType, ...args) {
        if (!nodeId || !actionType) {
            logger.warn(`执行操作失败：参数不完整`);
            return false;
        }

        try {
            const key = String(nodeId);
            const instance = this.getInstance(key);

        if (!instance) {
            logger.warn(`找不到节点 ${nodeId} 的实例`);
            return false;
        }

        logger.log(`执行节点 ${nodeId} 的 ${actionType} 操作`);


            if (actionType !== 'history') {
                this.closeHistoryPopup();
            }


        switch (actionType) {
            case 'history':

                    return this.showHistory(key, ...args);
            case 'undo':

                    return this.undoOperation(key, ...args);
            case 'redo':

                    return this.redoOperation(key, ...args);
            case 'translate':

                    return this.translateText(key, ...args);
                case 'expand':

                    return this.expandText(key, ...args);
            default:
                logger.warn(`未知操作类型: ${actionType}`);
                    return false;
            }
        } catch (error) {
            logger.error(`执行节点 ${nodeId} 的 ${actionType} 操作时出错:`, error);
                return false;
        }
    },


    showEffect(element, effectClass, duration = 300) {
        if (!element) return;
        element.classList.add(effectClass);
        setTimeout(() => element.classList.remove(effectClass), duration);
    },


    updateTextValue(element, newText) {
        if (!element) return;


        element.value = newText;


        const event = new Event('input', { bubbles: true });
        element.dispatchEvent(event);


        this.showEffect(element, 'prompt_text_updated');
    },


    createHistoryPopup(nodeId, history, anchorElement) {

        this.closeHistoryPopup();

        if (!history || !history.past || history.past.length === 0) {
            logger.warn("没有历史记录可显示");
            return null;
        }

        const historyArray = [...history.past].reverse();
        if (history.current) {
            historyArray.unshift(history.current);
        }


        const popup = document.createElement("div");
        popup.className = "prompt_history_popup";
        popup.setAttribute("data-node-id", nodeId);


        const titleBar = document.createElement("div");
        titleBar.className = "prompt_history_title_bar";


        const title = document.createElement("div");
        title.className = "prompt_history_title";
        title.textContent = "历史记录";


        const actions = document.createElement("div");
        actions.className = "prompt_history_actions";


        const clearCurrentBtn = document.createElement("button");
        clearCurrentBtn.className = "prompt_history_clear";
        clearCurrentBtn.textContent = "清除当前";


        clearCurrentBtn.addEventListener("click", (e) => {
            e.stopPropagation();

            this.clearHistory(nodeId);



            this.closeHistoryPopup();
        });


        const clearBtn = document.createElement("button");
        clearBtn.className = "prompt_history_clear";
        clearBtn.textContent = "清空全部";


        clearBtn.addEventListener("click", (e) => {
            e.stopPropagation();

            Array.from(this.history.keys()).forEach(id => {
                this.clearHistory(id);
            });



            this.closeHistoryPopup();
        });


        const closeBtn = document.createElement("button");
        closeBtn.className = "prompt_history_close";
        closeBtn.textContent = "×";

        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeHistoryPopup();
        });


        actions.appendChild(clearCurrentBtn);
        actions.appendChild(clearBtn);
        actions.appendChild(closeBtn);
        titleBar.appendChild(title);
        titleBar.appendChild(actions);
        popup.appendChild(titleBar);


        const listContainer = document.createElement("div");
        listContainer.className = "prompt_history_list";


        historyArray.forEach((text, index) => {
            if (!text.trim()) return;

            const isCurrent = (index === 0 && text === history.current);

            const item = document.createElement("div");
            item.className = `prompt_history_item${isCurrent ? " current" : ""}`;
            item.setAttribute("data-index", index);


            const itemContent = document.createElement("div");
            itemContent.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;

            const textSpan = document.createElement("span");
            textSpan.textContent = text.length > 40 ? text.substring(0, 40) + "..." : text;
            textSpan.title = text;

            const expandBtn = document.createElement("button");
            expandBtn.textContent = "⋯";
            expandBtn.title = "查看完整内容";
            expandBtn.style.cssText = `
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.4);
                font-size: 14px;
                cursor: pointer;
                padding: 0 4px;
                margin-left: 4px;
                display: ${text.length > 40 ? "block" : "none"};
                transition: all 0.2s;
            `;

            expandBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showTextPreview(text);
            });

            itemContent.appendChild(textSpan);
            itemContent.appendChild(expandBtn);
            item.appendChild(itemContent);

            item.addEventListener("click", (e) => {
                e.stopPropagation();
                this.applyHistoryItem(nodeId, text);
                this.closeHistoryPopup();
            });

            listContainer.appendChild(item);
        });

        popup.appendChild(listContainer);


        const rect = anchorElement.getBoundingClientRect();


        let left = rect.left;
        let top = rect.bottom + 5;


        if (left + 300 > window.innerWidth) {
            left = window.innerWidth - 310;
        }


        const popupHeight = 350;
        if (top + popupHeight > window.innerHeight) {

            top = rect.top - 5;
            popup.style.transformOrigin = "bottom";
            popup.style.top = "auto";
            popup.style.bottom = `${window.innerHeight - top}px`;
            popup.classList.add('popup_down');
        } else {
            popup.style.transformOrigin = "top";
            popup.style.top = `${Math.max(10, top)}px`;
            popup.style.bottom = "auto";
            popup.classList.add('popup_up');
        }

        popup.style.left = `${Math.max(10, left)}px`;


        document.body.appendChild(popup);
        this.activeHistoryPopup = popup;


        setTimeout(() => {
            document.addEventListener("click", this.handleDocumentClick);
        }, 10);

        return popup;
    },


    createHistoryPopupWithAllRecords(nodeId, historyRecords, anchorElement) {

        this.closeHistoryPopup();

        if (!historyRecords || historyRecords.length === 0) {
            logger.warn("没有历史记录可显示");
            return null;
        }


        const popup = document.createElement("div");
        popup.className = "prompt_history_popup";
        popup.setAttribute("data-node-id", nodeId);


        const titleBar = document.createElement("div");
        titleBar.className = "prompt_history_title_bar";


        const title = document.createElement("div");
        title.className = "prompt_history_title";
        title.textContent = "所有历史记录";


        const actions = document.createElement("div");
        actions.className = "prompt_history_actions";


        const clearCurrentBtn = document.createElement("button");
        clearCurrentBtn.className = "prompt_history_clear";
        clearCurrentBtn.textContent = "清除当前";


        clearCurrentBtn.addEventListener("click", (e) => {
            e.stopPropagation();

            this.clearHistory(nodeId);
            this.closeHistoryPopup();
        });


        const clearBtn = document.createElement("button");
        clearBtn.className = "prompt_history_clear";
        clearBtn.textContent = "清空全部";


        clearBtn.addEventListener("click", (e) => {
            e.stopPropagation();

            Array.from(this.history.keys()).forEach(id => {
                this.clearHistory(id);
            });


            this.closeHistoryPopup();
        });


        const closeBtn = document.createElement("button");
        closeBtn.className = "prompt_history_close";
        closeBtn.textContent = "×";

        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeHistoryPopup();
        });


        actions.appendChild(clearCurrentBtn);
        actions.appendChild(clearBtn);
        actions.appendChild(closeBtn);
        titleBar.appendChild(title);
        titleBar.appendChild(actions);
        popup.appendChild(titleBar);


        const listContainer = document.createElement("div");
        listContainer.className = "prompt_history_list";


        historyRecords.forEach((record, index) => {
            if (!record.text || !record.text.trim()) return;

            const item = document.createElement("div");
            item.className = `prompt_history_item${record.isCurrent ? " current" : ""}`;
            item.setAttribute("data-index", index);
            item.setAttribute("data-node-id", record.nodeId);


            if (record.isCurrentNode) {
                item.classList.add("current_node");
            }


            const itemContent = document.createElement("div");
            itemContent.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;


            const nodeIdSpan = document.createElement("span");

            nodeIdSpan.className = "prompt_history_node_id";


            if (record.isCurrentNode) {
                nodeIdSpan.classList.add('node_color_current');
            } else {

                const shortIdNum = parseInt(record.shortId) || 0;
                const colorIndex = shortIdNum % 10;
                nodeIdSpan.classList.add(`node_color_${colorIndex}`);
            }


            let textBoxId = '';
            if (record.nodeId.includes('_')) {
                textBoxId = record.nodeId.split('_').slice(1).join('_');
            }


            nodeIdSpan.textContent = textBoxId
                ? `#${record.shortId}: `
                : `#${record.shortId}: `;


            const textSpan = document.createElement("span");
            textSpan.className = "prompt_history_text";
            textSpan.textContent = record.text.length > 50 ? record.text.substring(0, 50) + "..." : record.text;
            textSpan.title = record.text;
            textSpan.style.cssText = `
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            `;


            const textContainer = document.createElement("div");
            textContainer.style.cssText = `
                display: flex;
                flex: 1;
                overflow: hidden;
                align-items: center;
            `;
            textContainer.appendChild(nodeIdSpan);
            textContainer.appendChild(textSpan);

            itemContent.appendChild(textContainer);
            item.appendChild(itemContent);


            item.addEventListener("click", (e) => {
                e.stopPropagation();
                this.applyHistoryItem(record.nodeId, record.text, nodeId);
                this.closeHistoryPopup();
            });

            listContainer.appendChild(item);
        });

        popup.appendChild(listContainer);


        const rect = anchorElement.getBoundingClientRect();


        let left = rect.left;
        let top = rect.bottom + 5;


        if (left + 300 > window.innerWidth) {
            left = window.innerWidth - 310;
        }


        const popupHeight = 350;
        if (top + popupHeight > window.innerHeight) {

            top = rect.top - 5;
            popup.style.transformOrigin = "bottom";
            popup.style.top = "auto";
            popup.style.bottom = `${window.innerHeight - top}px`;
            popup.classList.add('popup_down');
        } else {
            popup.style.transformOrigin = "top";
            popup.style.top = `${Math.max(10, top)}px`;
            popup.style.bottom = "auto";
            popup.classList.add('popup_up');
        }

        popup.style.left = `${Math.max(10, left)}px`;
        popup.style.width = "350px";


        popup.addEventListener("click", (e) => {
            e.stopPropagation();
        });


        const handleOutsideClick = (e) => {

            if (popup && !popup.contains(e.target) && e.target !== anchorElement) {
                this.closeHistoryPopup();

                document.removeEventListener("click", handleOutsideClick);
            }
        };


        setTimeout(() => {
            document.addEventListener("click", handleOutsideClick);
        }, 10);


        document.body.appendChild(popup);
        this.activeHistoryPopup = popup;

        return popup;
    },


    handleDocumentClick: function(e) {
        if (TranslateManager.activeHistoryPopup &&
            !TranslateManager.activeHistoryPopup.contains(e.target) &&
            !e.target.closest(".prompt_history_popup")) {
            TranslateManager.closeHistoryPopup();
        }
    },


    closeHistoryPopup() {
        if (this.activeHistoryPopup) {
            try {

                const useUpAnimation = this.activeHistoryPopup.classList.contains('popup_down');
                const closeAnimClass = useUpAnimation ? 'closing-up' : 'closing-down';


                this.activeHistoryPopup.classList.add(closeAnimClass);


                document.removeEventListener("click", this.handleDocumentClick);


                setTimeout(() => {
                    try {
                        if (this.activeHistoryPopup && document.body.contains(this.activeHistoryPopup)) {
                document.body.removeChild(this.activeHistoryPopup);
                        }
            } catch (error) {

                    }
                    this.activeHistoryPopup = null;
                }, 200);
            } catch (error) {

                try {
                    document.body.removeChild(this.activeHistoryPopup);
                } catch (e) {

            }
            this.activeHistoryPopup = null;
            document.removeEventListener("click", this.handleDocumentClick);
            }
        }
    },


    applyHistoryItem(nodeId, text, targetNodeId = null) {

        const actualTargetNodeId = targetNodeId || nodeId;

        const instance = this.getInstance(actualTargetNodeId);
        if (!instance?.text_element) {
            logger.warn(`无法应用历史记录：找不到节点 ${actualTargetNodeId} 的文本元素`);
            return false;
        }


        this.updateTextValue(instance.text_element, text);
        logger.log(`已应用历史记录(源自节点 ${nodeId})到节点 ${actualTargetNodeId}`);


        this.recordHistory(actualTargetNodeId, text);

        return true;
    },


    showHistory(nodeId) {
        if (!nodeId || !FEATURES.enabled || !FEATURES.history) return false;

        try {

            const key = String(nodeId);


            if (this.activePresetPopup) {
                this.closePresetPopup();
            }


            if (this.activeHistoryPopup) {

                this.closeHistoryPopup();
                return true;
            }

            this.initOrClearHistory(key);


            const instance = this.getInstance(key);

        if (!instance?.element || !instance.buttons?.history) {
            logger.warn(`无法显示历史记录：找不到节点 ${nodeId} 的元素或按钮`);
            return false;
        }


        this.showEffect(instance.buttons.history, 'widget_button_active');


            const allHistoryRecords = [];
            for (const [instanceId, historyData] of this.history.entries()) {
                if (historyData && ((historyData.past && historyData.past.length > 0) || historyData.current)) {

                    const shortNodeId = instanceId.replace(/^node_/i, '');

                    const baseNodeId = instanceId.split('_')[0];

                    const currentNodeBase = key.split('_')[0];
                    const isCurrentNode = baseNodeId === currentNodeBase;


                    if (historyData.current) {
                        allHistoryRecords.push({
                            nodeId: instanceId,
                            shortId: shortNodeId,
                            text: historyData.current,
                            isCurrent: true,
                            isCurrentNode: isCurrentNode,
                            index: historyData.past.length
                        });
                    }


                    if (historyData.past && historyData.past.length > 0) {
                        historyData.past.forEach((item, idx) => {
                            allHistoryRecords.push({
                                nodeId: instanceId,
                                shortId: shortNodeId,
                                text: item,
                                isCurrent: false,
                                isCurrentNode: isCurrentNode,
                                index: idx
                            });
                        });
                    }
                }
            }





            allHistoryRecords.sort((a, b) => {

                if (a.isCurrentNode !== b.isCurrentNode) {
                    return a.isCurrentNode ? -1 : 1;
                }


                const aBaseNodeId = a.nodeId.split('_')[0];
                const bBaseNodeId = b.nodeId.split('_')[0];


                if (aBaseNodeId !== bBaseNodeId) {
                    const aId = parseInt(aBaseNodeId.replace(/\D/g, '')) || 0;
                    const bId = parseInt(bBaseNodeId.replace(/\D/g, '')) || 0;
                    return aId - bId;
                }


                if (a.nodeId !== b.nodeId) {

                    const aTextBoxId = a.nodeId.includes('_') ? a.nodeId.split('_').slice(1).join('_') : '';
                    const bTextBoxId = b.nodeId.includes('_') ? b.nodeId.split('_').slice(1).join('_') : '';
                    return aTextBoxId.localeCompare(bTextBoxId);
                }



                return b.index - a.index;
            });


            if (allHistoryRecords.length > 0) {
                this.createHistoryPopupWithAllRecords(key, allHistoryRecords, instance.buttons.history);
                return true;
            } else {
                logger.info(`没有找到任何历史记录`);


                const historyButton = instance.buttons.history;
                if (historyButton) {
                    this.showStatusTip(historyButton, 'info', '当前无历史记录');
                }

                return false;
            }
        } catch (error) {
            logger.error(`节点 ${nodeId} 显示历史记录失败:`, error);
            return false;
        }
    },


    showTextPreview(text) {

        alert(text);
    },


    undoOperation(nodeId) {
        if (!nodeId) return;

        try {
            const key = String(nodeId);
            const history = this.history.get(key);

            if (!history || !history.past.length) return;

            const current = history.current;
            history.future.push(current);
            history.current = history.past.pop();


        this.updateButtonStates(nodeId);


            const instance = this.getInstance(key);
            if (!instance?.text_element) return;


            this.updateTextValue(instance.text_element, history.current);




            logger.log(`已撤销节点 ${nodeId} 的操作`);
        } catch (error) {
            logger.error(`撤销节点 ${nodeId} 的操作时出错:`, error);
        }
    },


    redoOperation(nodeId) {
        if (!nodeId) return;

        try {
            const key = String(nodeId);
            const history = this.history.get(key);

            if (!history || !history.future.length) return;

            const current = history.current;
            history.past.push(current);
            history.current = history.future.pop();


        this.updateButtonStates(nodeId);


            const instance = this.getInstance(key);
            if (!instance?.text_element) return;


            this.updateTextValue(instance.text_element, history.current);




            logger.log(`已重做节点 ${nodeId} 的操作`);
        } catch (error) {
            logger.error(`重做节点 ${nodeId} 的操作时出错:`, error);
        }
    },


    showStatusTip(textElement, status, message) {
        try {

            if (!this.statusTips) {
                this.statusTips = new Map();
            }


            let tipId;


            if (textElement.closest) {
                const widgetBox = textElement.closest('.prompt_widget_box');
                if (widgetBox) {
                    tipId = widgetBox.getAttribute('data-widget-key');
                }
            }


            if (!tipId) {
                tipId = textElement.getAttribute('data-element-id');
                if (!tipId) {
                    tipId = 'tip_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
                    textElement.setAttribute('data-element-id', tipId);
                }
            }


            const existingTip = this.statusTips.get(tipId);
            if (existingTip) {

                if (existingTip.timeoutId) clearTimeout(existingTip.timeoutId);
                if (existingTip.removeTimeoutId) clearTimeout(existingTip.removeTimeoutId);
                if (existingTip.shakeTimeoutId) clearTimeout(existingTip.shakeTimeoutId);


                if (existingTip.element && existingTip.animEndListener) {
                    existingTip.element.removeEventListener('animationend', existingTip.animEndListener);
                    existingTip.element.removeEventListener('transitionend', existingTip.animEndListener);
                }
            }


            let statusTip;
            let isNewTip = false;
            if (existingTip && existingTip.element && document.body.contains(existingTip.element)) {
                statusTip = existingTip.element;

                statusTip.classList.remove('success', 'error', 'loading', 'restore', 'float_out');


                statusTip.style.animation = 'none';

                void statusTip.offsetHeight;
            } else {
                statusTip = document.createElement("div");
                statusTip.className = "prompt_widget_status";
                document.body.appendChild(statusTip);
                isNewTip = true;
            }


            let translateButton = null;
            let historyButton = null;
            let expandButton = null;
            let presetButton = null;
            let widgetBox = null;


            if (textElement.tagName === 'BUTTON') {
                if (textElement.title && textElement.title.includes('历史')) {
                    historyButton = textElement;
                } else if (textElement.title && textElement.title.includes('扩写')) {
                    expandButton = textElement;
                } else if (textElement.title && textElement.title.includes('预设')) {
                    presetButton = textElement;
                }
            }


            if (textElement.tagName === 'TEXTAREA' ||
                textElement.tagName === 'INPUT' ||
                textElement.classList.contains('comfy-multiline-input')) {

                const nodeId = textElement.getAttribute('data-node-id') ||
                               textElement.closest('[data-node-id]')?.getAttribute('data-node-id');

                if (nodeId) {
                    const instance = this.getInstance(nodeId);
                    if (instance && instance.buttons) {
                        translateButton = instance.buttons.translate;
                        historyButton = instance.buttons.history;
                        expandButton = instance.buttons.expand;
                        presetButton = instance.buttons.preset;
                        widgetBox = instance.element;
                    }
                }
            }


            let referenceElement = textElement;
            if (status === 'success' && translateButton) {
                referenceElement = translateButton;
            } else if (status === 'loading' && translateButton) {
                referenceElement = translateButton;
            } else if (status === 'error' && translateButton) {
                referenceElement = translateButton;
            } else if (status === 'restore' && historyButton) {
                referenceElement = historyButton;
            } else if (historyButton && status.includes('history')) {
                referenceElement = historyButton;
            } else if (expandButton && status.includes('expand')) {
                referenceElement = expandButton;
            } else if (presetButton && status.includes('preset')) {
                referenceElement = presetButton;
            }


            statusTip.textContent = message;
            statusTip.setAttribute('data-tip-id', tipId);
            if (widgetBox) {
                statusTip.setAttribute('data-widget-key', widgetBox.getAttribute('data-widget-key'));
                statusTip.setAttribute('data-node-id', widgetBox.getAttribute('data-node-id'));
                statusTip.setAttribute('data-input-id', widgetBox.getAttribute('data-input-id'));
            }


            const rect = referenceElement.getBoundingClientRect();


            const tipLeft = rect.left + (rect.width / 2);
            const tipTop = rect.top;


            statusTip.style.position = 'absolute';
            statusTip.style.top = `${tipTop}px`;
            statusTip.style.left = `${tipLeft}px`;
            statusTip.style.transform = 'translate(-50%, -100%) translateY(-8px)';
            statusTip.style.whiteSpace = 'nowrap';


            statusTip.classList.add(status);
            statusTip.classList.add('status-tip-animation');


            statusTip.style.animation = 'tipScaleIn 0.2s  cubic-bezier(0.48,1.87,0.66,0.86) forwards';



            const tipInfo = {
                element: statusTip,


                timeoutId: setTimeout(() => {
                    if (statusTip && document.body.contains(statusTip)) {


                        statusTip.style.animation = 'clipFloatUp 0.5s ease-out forwards';


                        const animEndListener = () => {
                            if (statusTip && document.body.contains(statusTip)) {
                                document.body.removeChild(statusTip);
                                this.statusTips.delete(tipId);
                            }
                        };


                        statusTip.addEventListener('animationend', animEndListener, { once: true });


                        if (this.statusTips.has(tipId)) {
                            this.statusTips.get(tipId).animEndListener = animEndListener;
                        }


                        if (this.statusTips.has(tipId)) {
                           this.statusTips.get(tipId).removeTimeoutId = setTimeout(() => {
                                if (statusTip && document.body.contains(statusTip)) {
                                    logger.warn("Status tip animationEnd fallback triggered for", tipId);
                                    document.body.removeChild(statusTip);
                                    this.statusTips.delete(tipId);
                                }
                            }, 1000);
                        }
                    }
                }, 1000)
            };

            this.statusTips.set(tipId, tipInfo);
            return statusTip;
        } catch (error) {
            console.error('显示状态提示时出错:', error);
            return null;
        }
    },


    removeStatusTip(textElement) {
        try {
            if (!this.statusTips) return;


            if (textElement) {
                const tipId = textElement.getAttribute('data-element-id');
                if (tipId) {
                    const tipInfo = this.statusTips.get(tipId);
                    if (tipInfo && tipInfo.element && document.body.contains(tipInfo.element)) {

                        if (tipInfo.timeoutId) clearTimeout(tipInfo.timeoutId);
                        if (tipInfo.removeTimeoutId) clearTimeout(tipInfo.removeTimeoutId);


                        tipInfo.element.style.animation = "clipFloatUp 0.5s ease-in-out forwards";


                        setTimeout(() => {
                            if (tipInfo.element && document.body.contains(tipInfo.element)) {
                                document.body.removeChild(tipInfo.element);
                                this.statusTips.delete(tipId);
                            }
                        }, 800);
                    }
                }
            } else {

                for (const [tipId, tipInfo] of this.statusTips.entries()) {
                    if (tipInfo.element && document.body.contains(tipInfo.element)) {

                        if (tipInfo.timeoutId) clearTimeout(tipInfo.timeoutId);
                        if (tipInfo.removeTimeoutId) clearTimeout(tipInfo.removeTimeoutId);


                        tipInfo.element.style.animation = "clipFloatUp 0.5s ease-in-out forwards";


                        (function(id, info) {
                            setTimeout(() => {
                                if (info.element && document.body.contains(info.element)) {
                                    document.body.removeChild(info.element);
                                }
                            }, 800);
                        })(tipId, tipInfo);
                    }
                }


                setTimeout(() => {
                    this.statusTips.clear();
                }, 800);
            }
        } catch (error) {
            console.error('移除状态提示时出错:', error);
        }
    },


    disableAllButtons(nodeId, activeButtonKey = null) {
        const instance = this.getInstance(nodeId);
        if (!instance?.buttons) return;

        Object.keys(instance.buttons).forEach(key => {
            const button = instance.buttons[key];
            if (button) {

                if (key === activeButtonKey) {
                    button.classList.add('widget_button_active');

                } else {
                    button.classList.add('widget_button_disabled');
                    button.disabled = true;
                }
            }
        });
    },


    restoreButtonStates(nodeId, activeButtonKey = null) {
        const instance = this.getInstance(nodeId);
        if (!instance?.buttons) return;


        Object.keys(instance.buttons).forEach(key => {
            const button = instance.buttons[key];
            if (button) {
                button.classList.remove('widget_button_disabled');
                button.classList.remove('widget_button_active');
                button.disabled = false;
            }
        });


        this.updateButtonStates(nodeId);
    },


    translateText(nodeId) {

        if (!FEATURES.translate) {
            logger.warn("翻译功能已禁用");
            return false;
        }

        const instance = this.getInstance(nodeId);
        if (!instance?.text_element) {
            logger.error("未找到节点的文本元素:", nodeId);
            return false;
        }

        const textElement = instance.text_element;

        const translateButton = instance.buttons?.translate;


        const statusElement = translateButton || textElement;


        const currentText = textElement.value || "";
        if (!currentText.trim()) {
            logger.info("没有要翻译的文本");
            this.showStatusTip(statusElement, 'error', '没有要翻译的文本');
            return false;
        }


        if (instance.isTranslating || instance.isExpanding) {
            const message = instance.isTranslating ? '翻译处理中，请稍候...' : '扩写处理中，请稍候...';
            logger.warn(message);
            this.showStatusTip(statusElement, 'loading', message);
            return false;
        }


        if (instance.recordHistory) {
            instance.recordHistory(currentText);
        }


        if (this.translationCache.has(currentText)) {
            logger.info("在缓存中找到该文本，进行恢复操作");
            const cachedText = this.translationCache.get(currentText);


            this.updateTextValue(textElement, cachedText);


            this.recordHistory(nodeId, cachedText);


            let statusMessage = "已恢复";



            if (instance.originalText && currentText === instance.originalText) {

                statusMessage = "译文";
            } else {

                statusMessage = "原文";

                instance.originalText = cachedText;
            }


            this.showStatusTip(statusElement, 'restore', statusMessage);

            return true;
        }


        let from_lang = "auto";
        let to_lang = "auto";


        const chinese_chars = (currentText.match(/[\u4e00-\u9fff]/g) || []).length;
        const is_chinese = chinese_chars > currentText.length * 0.2;
        if (is_chinese) {
            to_lang = "en";
        } else {
            to_lang = "zh";
        }

        if (DEBUG) {
            logger.info(`检测到语言: ${is_chinese ? '中文' : '非中文'}, 目标语言: ${to_lang}`);
        }


        const originalBorder = textElement.style.border;
        textElement.style.border = "1px solid rgba(100, 100, 255, 0.5)";


        instance.isTranslating = true;


        if (translateButton) {
            translateButton.classList.add('widget_button_loading');
        }


        this.disableAllButtons(nodeId, 'translate');


        this.showStatusTip(statusElement, 'loading', '正在翻译...');


        if (DEBUG) {
            logger.info("发送翻译请求到后端...");
        }

        this.callBaiduTranslateAPI(currentText, nodeId, from_lang, to_lang).then(result => {

            instance.isTranslating = false;


            textElement.style.border = originalBorder;


            if (translateButton) {
                translateButton.classList.remove('widget_button_loading');
                translateButton.classList.remove('widget_button_active');
            }


            this.restoreButtonStates(nodeId);

            if (DEBUG) {
                logger.info("收到翻译响应:", result);
            }

            if (result.status === "success" && result.text) {
                const translatedText = result.text;
                if (DEBUG) {
                    logger.info(`翻译成功: ${translatedText.substring(0, 30)}${translatedText.length > 30 ? '...' : ''}`);
                }


                this.updateTextValue(instance.text_element, translatedText);


                this.translationCache.set(currentText, translatedText);
                this.translationCache.set(translatedText, currentText);


                this.recordHistory(nodeId, translatedText);


                instance.originalText = currentText;


                this.showStatusTip(statusElement, 'success', result.from_cache ? '使用缓存翻译' : '翻译完成');
            } else {
                this.showStatusTip(statusElement, 'error', result.message || "翻译失败");
            }
        }).catch(error => {

            instance.isTranslating = false;


            textElement.style.border = originalBorder;


            if (translateButton) {
                translateButton.classList.remove('widget_button_loading');
                translateButton.classList.remove('widget_button_active');
            }


            this.restoreButtonStates(nodeId);

            logger.error("翻译请求失败:", error);
            this.showStatusTip(statusElement, 'error', `请求失败: ${error.message}`);
        });

        return true;
    },


    async expandText(nodeId) {
        const instance = this.getInstance(nodeId);
        if (!instance?.text_element) {
            logger.error("未找到节点的文本元素:", nodeId);
            return false;
        }

        const textElement = instance.text_element;

        const expandButton = instance.buttons?.expand;


        const statusElement = expandButton || textElement;


        const currentText = textElement.value || "";
        if (!currentText.trim()) {
            logger.info("没有要扩写的文本");
            this.showStatusTip(statusElement, 'error', '没有要扩写的文本');
            return false;
        }


        if (instance.isExpanding || instance.isTranslating) {
            const message = instance.isExpanding ? '扩写中，请稍候...' : '翻译中，请稍候...';
            logger.warn(message);
            this.showStatusTip(statusElement, 'loading', message);
            return false;
        }


        if (instance.recordHistory) {
            instance.recordHistory(currentText);
        }


        const originalBorder = textElement.style.border;
        textElement.style.border = "1px solid rgba(100, 255, 100, 0.5)";


        instance.isExpanding = true;


        if (expandButton) {
            expandButton.classList.add('widget_button_loading');
        }


        this.disableAllButtons(nodeId, 'expand');


        this.showStatusTip(statusElement, 'loading', '正在扩写...');

        try {

            const response = await fetch('/expand_text', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: currentText,
                    node_id: nodeId
                })
            });


            instance.isExpanding = false;


            textElement.style.border = originalBorder;


            if (expandButton) {
                expandButton.classList.remove('widget_button_loading');
                expandButton.classList.remove('widget_button_active');
            }


            this.restoreButtonStates(nodeId);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            if (result.success && result.expanded_text) {
                const expandedText = result.expanded_text;


                this.updateTextValue(instance.text_element, expandedText);


                this.forceRecordHistory(nodeId, expandedText);


                this.showStatusTip(statusElement, 'success', '扩写完成');

                return true;
            } else {

                throw new Error(result.error || '扩写失败');
            }
        } catch (error) {

            instance.isExpanding = false;


            textElement.style.border = originalBorder;


            if (expandButton) {
                expandButton.classList.remove('widget_button_loading');
                expandButton.classList.remove('widget_button_active');
            }


            this.restoreButtonStates(nodeId);


            const errorMsg = error.message || '无法连接LLM服务';
            this.showStatusTip(statusElement, 'error', `扩写失败: ${errorMsg}`);
            logger.error(`扩写文本时出错:`, error);
            return false;
        }
    },


    forceRecordHistory(nodeId, text) {
        if (!nodeId) return;

        try {
            this.initOrClearHistory(nodeId);
            const key = String(nodeId);
            const history = this.history.get(key);

            if (!history) return;


            history.past.push(history.current);
            history.current = text;
            history.future = [];


            if (history.past.length > 20) {
                history.past.shift();
            }


            this.updateButtonStates(nodeId);
        } catch (error) {
            logger.error(`强制记录节点 ${nodeId} 的历史时出错:`, error);
        }
    },


    async loadPresets() {
        try {
            if (this.presets) return this.presets;


            const presetUrl = '/prompt_widget/presets';

            const response = await fetch(presetUrl);
            if (!response.ok) {
                throw new Error(`Failed to load presets: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            this.presets = data.presets || [];
            logger.log(`成功加载 ${this.presets.length} 个预设`);
            return this.presets;
        } catch (error) {
            logger.error("加载预设失败:", error);
            this.presets = [];
            return [];
        }
    },


    async showPresets(nodeId) {
        if (!nodeId || !FEATURES.enabled || !FEATURES.preset) return false;

        try {

            const key = String(nodeId);


            if (this.activeHistoryPopup) {
                this.closeHistoryPopup();
            }


            if (this.activePresetPopup) {

                this.closePresetPopup();
                return true;
            }


            const instance = this.getInstance(key);

            if (!instance?.element || !instance.buttons?.preset) {
                logger.warn(`无法显示预设：找不到节点 ${nodeId} 的元素或按钮`);
                return false;
            }


            this.showEffect(instance.buttons.preset, 'widget_button_active');


            await this.loadPresets();

            if (!this.presets || this.presets.length === 0) {
                logger.info(`没有找到任何预设`);
                this.showStatusTip(instance.buttons.preset, 'info', "没有可用的预设");
                return false;
            }


            this.createPresetPopup(key, this.presets, instance.buttons.preset);
            return true;
        } catch (error) {
            logger.error(`节点 ${nodeId} 显示预设失败:`, error);
            return false;
        }
    },


    createPresetPopup(nodeId, presets, anchorElement) {

        this.closePresetPopup();

        if (!presets || presets.length === 0) {
            logger.warn("没有预设可显示");
            return null;
        }


        const popup = document.createElement("div");
        popup.className = "prompt_history_popup";
        popup.setAttribute("data-node-id", nodeId);


        const titleBar = document.createElement("div");
        titleBar.className = "prompt_history_title_bar";


        const title = document.createElement("div");
        title.className = "prompt_history_title";
        title.textContent = "提示词预设";


        const actions = document.createElement("div");
        actions.className = "prompt_history_actions";


        const closeBtn = document.createElement("button");
        closeBtn.className = "prompt_history_close";
        closeBtn.textContent = "×";

        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closePresetPopup();
        });


        actions.appendChild(closeBtn);
        titleBar.appendChild(title);
        titleBar.appendChild(actions);
        popup.appendChild(titleBar);


        const listContainer = document.createElement("div");
        listContainer.className = "prompt_history_list";


        presets.forEach((preset, index) => {
            if (!preset.content || !preset.content.trim()) return;

            const item = document.createElement("div");
            item.className = "prompt_history_item";
            item.setAttribute("data-index", index);


            const instance = TranslateManager.getInstance(nodeId);
            const currentText = instance?.text_element?.value || "";
            const isPresetApplied = currentText.includes(preset.content);


            const typeSpan = document.createElement("span");
            typeSpan.className = "prompt_preset_type";
            typeSpan.textContent = preset.type || "未分类";


            if (preset.color_type) {

                typeSpan.classList.add(`preset_type_${preset.color_type}`);
            } else {

                switch (preset.type) {
                    case "质量指示词":
                        typeSpan.classList.add("preset_type_quality");
                        break;
                    case "风格提示词":
                        typeSpan.classList.add("preset_type_style");
                        break;
                    case "负面提示词":
                        typeSpan.classList.add("preset_type_negative");
                        break;
                    default:
                        typeSpan.classList.add("preset_type_default");
                }
            }


            const contentSpan = document.createElement("span");
            contentSpan.className = "prompt_preset_content";
            contentSpan.textContent = preset.content.length > 50 ? preset.content.substring(0, 50) + "..." : preset.content;
            contentSpan.title = preset.content;


            const noteSpan = document.createElement("span");
            noteSpan.className = "prompt_preset_note";
            noteSpan.textContent = preset.note || "";
            noteSpan.title = preset.note;


            const cleanButtonContainer = document.createElement("span");
            cleanButtonContainer.className = "preset-clean-button-container";
            cleanButtonContainer.style.display = isPresetApplied ? "inline-flex" : "none";


            const cleanButton = document.createElement("button");
            cleanButton.className = "preset-action-button erase-button";
            cleanButton.title = "从输入框中清除此预设";


            cleanButton.addEventListener("click", (e) => {
                e.stopPropagation();
                TranslateManager.cleanPresetFromInput(nodeId, preset.content);
                cleanButtonContainer.style.display = "none";
            });

            cleanButtonContainer.appendChild(cleanButton);


            const itemContent = document.createElement("div");
            itemContent.style.cssText = `
                display: flex;
                flex-direction: column;
                width: 100%;
            `;

            const topRow = document.createElement("div");
            topRow.style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 4px;
            `;
            topRow.appendChild(typeSpan);
            topRow.appendChild(noteSpan);

            const contentRow = document.createElement("div");
            contentRow.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
            `;
            contentRow.appendChild(contentSpan);
            contentRow.appendChild(cleanButtonContainer);

            itemContent.appendChild(topRow);
            itemContent.appendChild(contentRow);
            item.appendChild(itemContent);


            item.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!isPresetApplied) {
                    TranslateManager.applyPreset(nodeId, preset.content);
                    cleanButtonContainer.style.display = "inline-flex";
                }
            });


            if (isPresetApplied) {
                item.classList.add("preset-applied");
                item.style.backgroundColor = "rgba(100, 255, 100, 0.1)";
            }

            listContainer.appendChild(item);
        });

        popup.appendChild(listContainer);


        const rect = anchorElement.getBoundingClientRect();


        let left = rect.left;
        let top = rect.bottom + 5;


        if (left + 300 > window.innerWidth) {
            left = window.innerWidth - 310;
        }


        const popupHeight = 350;
        if (top + popupHeight > window.innerHeight) {

            top = rect.top - 5;
            popup.style.transformOrigin = "bottom";
            popup.style.top = "auto";
            popup.style.bottom = `${window.innerHeight - top}px`;
            popup.classList.add('popup_down');
        } else {
            popup.style.transformOrigin = "top";
            popup.style.top = `${Math.max(10, top)}px`;
            popup.style.bottom = "auto";
            popup.classList.add('popup_up');
        }

        popup.style.left = `${Math.max(10, left)}px`;


        document.body.appendChild(popup);


        this.activePresetPopup = popup;


        this.handleDocumentClick = (e) => {

            if (popup && !popup.contains(e.target) && e.target !== anchorElement) {
                this.closePresetPopup();
            }
        };


        setTimeout(() => {
            document.addEventListener("click", this.handleDocumentClick);
        }, 10);

        return popup;
    },


    closePresetPopup() {
        try {
            if (this.activePresetPopup) {

                const useUpAnimation = this.activePresetPopup.classList.contains('popup_down');
                const closeAnimClass = useUpAnimation ? 'closing-up' : 'closing-down';


                this.activePresetPopup.classList.add(closeAnimClass);


            if (this.handleDocumentClick) {
                document.removeEventListener("click", this.handleDocumentClick);
                this.handleDocumentClick = null;
            }


                setTimeout(() => {
                    try {
                        if (this.activePresetPopup && document.body.contains(this.activePresetPopup)) {
                    document.body.removeChild(this.activePresetPopup);
                        }
                    } catch (error) {

                }
                this.activePresetPopup = null;
                }, 200);
            }
        } catch (error) {

            try {
                if (this.activePresetPopup && document.body.contains(this.activePresetPopup)) {
                    document.body.removeChild(this.activePresetPopup);
                }
            } catch (e) {

            }
            this.activePresetPopup = null;
            if (this.handleDocumentClick) {
                document.removeEventListener("click", this.handleDocumentClick);
                this.handleDocumentClick = null;
            }
        }
    },


    applyPreset(nodeId, presetContent) {
        if (!nodeId || !FEATURES.enabled || !FEATURES.preset) return false;

        const instance = this.getInstance(nodeId);
        if (!instance?.text_element) {
            logger.error("未找到节点的文本元素:", nodeId);
            return false;
        }

        const textElement = instance.text_element;


        const currentText = textElement.value || "";
        const cursorPos = textElement.selectionStart;
        const hasCursor = cursorPos !== undefined && cursorPos !== null;


        if (currentText.includes(presetContent)) {
            this.showStatusTip(instance.buttons.preset, 'info', '预设内容已存在');
            return false;
        }


        const cleanPreset = presetContent.trim().replace(/^,+|,+$/g, '');

        let newText;
        if (!currentText) {

            newText = cleanPreset;
        } else if (hasCursor) {

            const beforeCursor = currentText.substring(0, cursorPos).trim();
            const afterCursor = currentText.substring(cursorPos).trim();


            let prefix = beforeCursor;
            if (prefix && !prefix.endsWith(',')) {
                prefix += ', ';
            } else if (prefix && prefix.endsWith(',')) {
                prefix += ' ';
            }


            let suffix = afterCursor;
            if (suffix && !suffix.startsWith(',')) {
                suffix = ', ' + suffix;
            } else if (suffix && suffix.startsWith(',')) {
                suffix = ' ' + suffix;
            }


            newText = prefix + cleanPreset + (suffix ? suffix : '');


            const newCursorPos = prefix.length + cleanPreset.length;


            setTimeout(() => {
                textElement.selectionStart = newCursorPos;
                textElement.selectionEnd = newCursorPos;
            }, 0);
        } else {

            const cleanCurrentText = currentText.trim().replace(/,+$/g, '');
            newText = cleanCurrentText ? `${cleanCurrentText}, ${cleanPreset}` : cleanPreset;
        }


        newText = newText.trim()
            .replace(/\s*,\s*/g, ', ')
            .replace(/,+/g, ',')
            .replace(/^,+|,+$/g, '')
            .trim();


        this.updateTextValue(textElement, newText);


        this.recordHistory(nodeId, newText);


        this.showStatusTip(instance.buttons.preset, 'success', '已应用预设');


        this.updatePresetItemState(nodeId, presetContent, true);

        return true;
    },


    updatePresetItemState(nodeId, presetContent, isApplied) {
        try {

            const presetItems = document.querySelectorAll('.prompt_history_item');
            presetItems.forEach(item => {
                const contentSpan = item.querySelector('.prompt_preset_content');
                if (contentSpan && (contentSpan.textContent === presetContent ||
                    contentSpan.title === presetContent)) {


                    if (isApplied) {
                        item.classList.add('preset-applied');
                        item.style.backgroundColor = "rgba(100, 255, 100, 0.1)";
                    } else {
                        item.classList.remove('preset-applied');
                        item.style.backgroundColor = "";
                    }


                    const cleanButton = item.querySelector('.preset-clean-button-container');
                    if (cleanButton) {
                        cleanButton.style.display = isApplied ? "inline-flex" : "none";
                    }
                }
            });
        } catch (error) {
            logger.error("更新预设项状态时出错:", error);
        }
    },


    executeAction(nodeId, actionType, ...args) {
        if (!nodeId || !actionType) {
            logger.error(`执行操作失败: ${nodeId}, ${actionType}`);
            return false;
        }

        try {

            const key = String(nodeId);


            if (!this.hasInstance(key)) {
                logger.error(`找不到节点实例: ${nodeId}`);
                return false;
            }


            switch (actionType.toLowerCase()) {
                case 'history':
                    return this.showHistory(key);
                case 'undo':
                    return this.undoOperation(key);
                case 'redo':
                    return this.redoOperation(key);
                case 'translate':
                    return this.translateText(key);
                case 'expand':
                    return this.expandText(key);
                case 'preset':
                    return this.showPresets(key);
                default:
                    logger.error(`未知的操作类型: ${actionType}`);
                    return false;
            }
        } catch (error) {
            logger.error(`执行操作 ${actionType} 出错:`, error);
            return false;
        }
    },


    async reloadConfig() {
        try {

            const config = await loadConfig();

            this.presets = null;
            await this.loadPresets();

            logger.info("配置已重新加载");
            return true;
        } catch (error) {
            logger.error("重新加载配置失败:", error);
            return false;
        }
    },


    cleanPresetFromInput(nodeId, presetContent) {
        if (!nodeId || !presetContent) return false;

        const instance = this.getInstance(nodeId);
        if (!instance?.text_element) {
            logger.error("未找到节点的文本元素:", nodeId);
            return false;
        }

        const textElement = instance.text_element;
        const currentText = textElement.value || "";


        if (!currentText.includes(presetContent)) {
            this.showStatusTip(instance.buttons.preset, 'info', '未找到预设内容');
            return false;
        }


        let newText = currentText;


        newText = newText.replace(`, ${presetContent}`, '');


        newText = newText.replace(`${presetContent}, `, '');


        newText = newText.replace(presetContent, '');


        newText = newText.replace(/,\s*,/g, ',')
                        .replace(/^\s*,\s*/, '')
                        .replace(/\s*,\s*$/, '')
                        .trim();


        this.updateTextValue(textElement, newText);


        this.recordHistory(nodeId, newText);


        this.showStatusTip(instance.buttons.preset, 'success', '已清除预设');


        this.updatePresetItemState(nodeId, presetContent, false);

        return true;
    },
};




function getPosition(ctx, w_width, y, n_height, wInput, node) {
    if (!ctx || !wInput?.inputEl) {
        logger.warn("无法计算位置: 上下文或输入元素缺失");
        return null;
    }

    try {

        if (node && node.flags && node.flags.collapsed) {
            return { display: "none" };
        }

        const rect = ctx.canvas.getBoundingClientRect();
        const transform = new DOMMatrix()
            .scaleSelf(rect.width / ctx.canvas.width, rect.height / ctx.canvas.height)
            .multiplySelf(ctx.getTransform());
        const scale = new DOMMatrix().scaleSelf(transform.a, transform.d);

        const textInputRect = wInput.inputEl.getBoundingClientRect();

        if (!textInputRect.width || !textInputRect.height) {
            logger.warn("文本输入框尺寸无效", textInputRect);
            return { display: "none" };
        }

        return {
            transformOrigin: "0 0",
            transform: scale,
            left: `${textInputRect.right - (120 * scale.a) - 16}px`,
            top: `${textInputRect.bottom + 4}px`,
            zIndex: +(wInput.inputEl.style.zIndex || 20) + 1,
            display: "flex"
        };
    } catch (error) {
        logger.error("计算位置时出错:", error);
        return { display: "none" };
    }
}


function createIconButton(iconPath, title, onClick, widgetKey) {

    const baseUrl = import.meta.url.replace('prompt_widget.js', 'assets/');
    const fullIconPath = new URL(iconPath, baseUrl).href;


    let nodeId, inputId;
    if (widgetKey && widgetKey.includes('_')) {
        [nodeId, inputId] = widgetKey.split('_', 2);
    } else {
        nodeId = widgetKey;
        inputId = 'default';
    }


    const safeWidgetKey = widgetKey.replace(/\s+/g, '-');

    const button = $el("button.widget_icon_button", {
        onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();

            button.classList.add("widget_button_active");
            setTimeout(() => button.classList.remove("widget_button_active"), 200);

            onClick?.(widgetKey);
        },
        style: {
            backgroundImage: `url('${fullIconPath}')`
        },
        title,
        dataset: {
            nodeId: nodeId.replace(/\s+/g, '-'),
            inputId: inputId.replace(/\s+/g, '-'),
            widgetKey: safeWidgetKey
        }
    });


    button.setAttribute('data-node-id', nodeId.replace(/\s+/g, '-'));
    button.setAttribute('data-input-id', inputId.replace(/\s+/g, '-'));
    button.setAttribute('data-widget-key', safeWidgetKey);
    button.classList.add('translate-button-' + safeWidgetKey);


    TranslateManager.addHoverEffect(button);

    return button;
}


function createDivider() {
    return $el("div.widget_divider");
}


function TranslateWidget(node, inputName, inputData, widgetsText) {

    if (!FEATURES.enabled) {
        return null;
    }

    const nodeId = node.id;
    const inputId = inputName || "default";
    const widgetKey = `${nodeId}_${inputId}`;

    logger.log(`尝试创建翻译小部件: ${widgetKey}`);


    if (TranslateManager.hasInstance(widgetKey)) {
        logger.log(`输入控件已有翻译小部件实例，先清理`);
        TranslateManager.cleanup(widgetKey);
    }

    const widget = {
        type: "translate_widget",
        name: inputId,
        nodeId: nodeId,
        inputId: inputId,
        widgetKey: widgetKey,
        buttons: {},
        text_element: widgetsText?.inputEl,
        node: node,
        isTranslating: false
    };


    if (widget.text_element) {
        let previousValue = widget.text_element.value || "";


        const shouldRecordHistory = (currentValue) => {

            if (!FEATURES.history) {
                return false;
            }


            if (!currentValue.trim()) return false;


            const history = TranslateManager.history.get(widgetKey);
            if (history && (
                history.current === currentValue ||
                history.past.includes(currentValue)
            )) {
                return false;
            }

            return true;
        };


        const recordHistory = (currentValue) => {
            if (shouldRecordHistory(currentValue)) {
                TranslateManager.recordHistory(widgetKey, currentValue);
                previousValue = currentValue;

                TranslateManager.updateButtonStates(widgetKey);
            }
        };


        const blurHandler = () => {
            if (widget.text_element) {
                const currentValue = widget.text_element.value;
                recordHistory(currentValue);
            }
        };


        widget.text_element.addEventListener("blur", blurHandler);

        widget.recordHistory = recordHistory;

        widget.blurHandler = blurHandler;
    }

    const buttonActions = {
        history: (widgetKey) => TranslateManager.executeAction(widgetKey, 'history'),
        undo: (widgetKey) => TranslateManager.executeAction(widgetKey, 'undo'),
        redo: (widgetKey) => TranslateManager.executeAction(widgetKey, 'redo'),
        expand: (widgetKey) => TranslateManager.executeAction(widgetKey, 'expand'),
        translate: (widgetKey) => TranslateManager.executeAction(widgetKey, 'translate'),
        preset: (widgetKey) => TranslateManager.executeAction(widgetKey, 'preset')
    };


    const buttons = {
        history: ['icon-history.svg', '历史记录'],
        undo: ['icon-undo.svg', '撤销'],
        redo: ['icon-redo.svg', '重做'],
        preset: ['icon-preset.svg', '提示词预设'],
        expand: ['icon-expand.svg', '扩写文本'],
        translate: ['icon-translate.svg', '翻译文本']
    };


    const buttonElements = [];


    if (FEATURES.history) {
        ['history', 'undo', 'redo'].forEach(key => {
            try {
                const [icon, title] = buttons[key];
            widget.buttons[key] = createIconButton(
                    icon,
                title,
                buttonActions[key],
                widgetKey
            );
                buttonElements.push(widget.buttons[key]);
        } catch (error) {
            logger.error(`创建按钮 ${key} 失败:`, error);
            }
        });

        buttonElements.push(createDivider());
    }


    if (FEATURES.preset) {
        try {
            const [icon, title] = buttons.preset;
            widget.buttons.preset = createIconButton(
                icon,
                title,
                buttonActions.preset,
                widgetKey
            );
            buttonElements.push(widget.buttons.preset);
        } catch (error) {
            logger.error("创建预设按钮失败:", error);
        }
    }


    if (FEATURES.expand) {
        try {
            const [icon, title] = buttons.expand;
            widget.buttons.expand = createIconButton(
                icon,
                title,
                buttonActions.expand,
                widgetKey
            );
            buttonElements.push(widget.buttons.expand);
        } catch (error) {
            logger.error("创建扩写按钮失败:", error);
        }
    }


    if (FEATURES.translate) {
        try {
            const [icon, title] = buttons.translate;
            widget.buttons.translate = createIconButton(
                icon,
                title,
                buttonActions.translate,
                widgetKey
            );
            buttonElements.push(widget.buttons.translate);
        } catch (error) {
            logger.error("创建翻译按钮失败:", error);
        }
    }


    if (buttonElements.length === 0) {
        return null;
    }


    widget.element = $el("div.prompt_widget_box",
        [
            ...buttonElements,
            $el("div.prompt_translate_info", [
                $el("span", {
                    textContent: "",
                    style: { fontSize: "0.8em" }
                })
            ])
        ]
    );


    widget.element.setAttribute('data-node-id', nodeId);
    widget.element.setAttribute('data-input-id', inputId);
    widget.element.setAttribute('data-widget-key', widgetKey);


    widget.element.addEventListener('click', (e) => {
        e.stopPropagation();
    });


    widget.updatePosition = function() {

    };


    if (widget.text_element) {
        TranslateManager.initOrClearHistory(widgetKey);
        TranslateManager.recordHistory(widgetKey, widget.text_element.value || "");
    }


    TranslateManager.addInstance(widgetKey, widget);


    TranslateManager.updateButtonStates(widgetKey);

    logger.log(`成功创建节点 ${nodeId} 输入 ${inputId} 的翻译小部件实例`);
    return widget;
}


const PromptWidget = {
    name: EXTENSION_NAME,
    nodes: {},
    styleElement: null,
    userActive: false,
    activityTimeout: null,
    _resetUserActivityHandler: null,


    initialize() {
        logger.info("初始化PromptWidget扩展");


        this.styleElement = addStylesheet();


        TranslateManager.setupWebSocket();


        let cleanupInterval = 60;
        try {
            const savedInterval = app.ui.settings.getSettingValue("PromptWidget.Cleanup.Interval");
            if (typeof savedInterval === 'number' && savedInterval >= 10 && savedInterval <= 120) {
                cleanupInterval = savedInterval;
            }
        } catch (error) {
            logger.warn("读取清理间隔设置失败，使用默认值60秒");
        }


        this.startPeriodicCleanup(cleanupInterval * 1000);


        this.initUserActivityTracking();
    },


    initUserActivityTracking() {

        this.userActive = false;


        const resetUserActivity = () => {
            this.userActive = true;
            clearTimeout(this.activityTimeout);
            this.activityTimeout = setTimeout(() => {
                this.userActive = false;
            }, 5000);
        };


        this._resetUserActivityHandler = resetUserActivity;


        document.addEventListener('mousemove', this._resetUserActivityHandler, { passive: true });
        document.addEventListener('keydown', this._resetUserActivityHandler, { passive: true });
        document.addEventListener('click', this._resetUserActivityHandler, { passive: true });


        resetUserActivity();

        logger.log("用户活跃度检测已初始化");
    },


    startPeriodicCleanup(interval = 60000) {

        if (!FEATURES.enabled) return;


        const validInterval = Math.max(10000, Math.min(120000, interval));


        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }


        this.cleanupInterval = setInterval(() => {

            if (!FEATURES.enabled) {
                this.stopPeriodicCleanup();
                return;
            }


            if (!this.userActive && TranslateManager.instances.size > 0) {
            TranslateManager.cleanupEmptyInstances('timer');
            }
        }, validInterval);

        logger.log(`已启动智能定期清理，间隔 ${validInterval/1000} 秒，仅在用户不活跃时执行`);
    },


    stopPeriodicCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;


            if (this.activityTimeout) {
                clearTimeout(this.activityTimeout);
                this.activityTimeout = null;
            }


            if (this._resetUserActivityHandler) {
                document.removeEventListener('mousemove', this._resetUserActivityHandler);
                document.removeEventListener('keydown', this._resetUserActivityHandler);
                document.removeEventListener('click', this._resetUserActivityHandler);
                this._resetUserActivityHandler = null;
            }

            logger.log("已停止定期空实例清理");
        }
    },


    checkAndSetupNode(node) {

        if (!node || !FEATURES.enabled) {
            return;
        }


        if (!FEATURES.enabled && node.id) {
            this.hideNodeWidgets(node);
            TranslateManager.cleanup(node.id);
            return;
        }

        const nodeId = node.id;


        if (node.flags && node.flags.collapsed) {
            this.hideNodeWidgets(node);
            return;
        }

        logger.log(`检查节点: ${nodeId}, 类型: ${node.type}`);


        const multilineInputs = [];

        if (node.widgets) {
            node.widgets.forEach(widget => {

                if (
                    (widget.name === "text" || widget.type === "text") ||
                    (widget.type === "string" && widget.options && widget.options.multiline) ||
                    (widget.multiline === true) ||
                    (widget.inputEl && widget.inputEl.tagName === "TEXTAREA")
                ) {

                    if (widget.inputEl && typeof widget.inputEl.value === "string") {
                        multilineInputs.push(widget);
                    }
                }
            });
        }

        if (multilineInputs.length > 0) {
            logger.log(`节点 ${nodeId} 包含 ${multilineInputs.length} 个多行输入控件`);


            multilineInputs.forEach(inputWidget => {
                this.setupNodeWidget(node, inputWidget);
            });
        }
    },


    setupNodeWidget(node, inputWidget) {
        if (!node || !inputWidget || !inputWidget.inputEl) return;

        const nodeId = node.id;
        const inputId = inputWidget.name || inputWidget.id || Math.random().toString(36).substring(2, 10);
        const widgetKey = `${nodeId}_${inputId}`;

        logger.log(`为节点 ${nodeId} 的输入控件 ${inputId} 设置翻译小部件`);


        if (inputWidget.inputEl.readOnly || inputWidget.inputEl.disabled) {
            logger.log(`跳过只读或禁用的输入控件`);
            return;
        }


        const existingWidget = TranslateManager.getInstance(widgetKey);
        if (existingWidget && existingWidget.text_element === inputWidget.inputEl) {

            if (existingWidget.isHiding) {
                existingWidget.isHiding = false;
                if (existingWidget.hideTimeout) {
                    clearTimeout(existingWidget.hideTimeout);
                    existingWidget.hideTimeout = null;
                }
            }


            if (existingWidget.element) {

                if (window.getComputedStyle(existingWidget.element).display !== 'none' &&
                    existingWidget.element.classList.contains('widget_show')) {
                    return;
                }


                existingWidget.element.classList.remove('widget_hide');


                existingWidget.element.style.opacity = '0';
                existingWidget.element.style.display = 'flex';


                void existingWidget.element.offsetWidth;


                existingWidget.element.classList.add('widget_show');
            }
            return;
        }

        try {

            const widget = TranslateWidget(node, inputId, null, inputWidget);

            widget.nodeId = nodeId;
            widget.inputId = inputId;
            widget.widgetKey = widgetKey;


            const isCompatibilityMode = app.ui.settings.getSettingValue("PromptWidget.Compatibility.Mode");


            const container = inputWidget.inputEl.parentElement;


            if (isCompatibilityMode || !container || !container.classList.contains('dom-widget')) {

                if (DEBUG) console.log("[PromptWidget]🔧兼容模式");


                const containerDiv = document.createElement('div');
                containerDiv.className = 'prompt-widget-container';
                containerDiv.style.position = 'fixed';
                containerDiv.style.zIndex = '999';
                containerDiv.style.display = 'flex';
                containerDiv.style.justifyContent = 'flex-end';
                containerDiv.style.pointerEvents = 'none';


                if (widget.element) {
                    containerDiv.appendChild(widget.element);
                    document.body.appendChild(containerDiv);


                    widget.element.style.pointerEvents = 'auto';
                    widget.element.style.zIndex = '999';

                    const updateWidgetPosition = () => {
                        if (!widget.element || !inputWidget.inputEl || !containerDiv) return;

                        try {

                            const inputRect = inputWidget.inputEl.getBoundingClientRect();


                            Object.assign(containerDiv.style, {
                                left: `${inputRect.left - 12}px`,
                                top: `${inputRect.bottom - 34}px`,
                                width: `${inputRect.width}px`,
                                height: '24px',
                                pointerEvents: 'none',
                                zIndex: '999'
                            });


                            Object.assign(widget.element.style, {
                                transformOrigin: 'right center',
                                margin: '0',
                                pointerEvents: 'auto',
                                zIndex: '9999999'
                            });
                        } catch (error) {
                            console.error("更新小部件位置时出错:", error);
                        }
                    };


                    updateWidgetPosition();


                    const debouncedUpdatePosition = debounce(updateWidgetPosition, 100);


                    window.addEventListener('resize', debouncedUpdatePosition);


                    const observer = new MutationObserver(debouncedUpdatePosition);


                    observer.observe(app.canvas.canvas.parentElement, {
                        attributes: true,
                        attributeFilter: ['style', 'transform']
                    });


                    const originalDrawBackground = app.canvas.onDrawBackground;
                    app.canvas.onDrawBackground = function() {
                        const ret = originalDrawBackground?.apply(this, arguments);
                        debouncedUpdatePosition();
                        return ret;
                    };


                    const originalOnNodeMoved = node.onNodeMoved;
                    node.onNodeMoved = function() {
                        const ret = originalOnNodeMoved?.apply(this, arguments);
                        debouncedUpdatePosition();
                        return ret;
                    };


                    widget.updatePosition = debouncedUpdatePosition;


                    widget.cleanup = () => {
                        window.removeEventListener('resize', debouncedUpdatePosition);
                        observer.disconnect();
                        if (originalDrawBackground) {
                            app.canvas.onDrawBackground = originalDrawBackground;
                        }
                        if (originalOnNodeMoved) {
                            node.onNodeMoved = originalOnNodeMoved;
                        }
                        if (containerDiv && document.body.contains(containerDiv)) {
                            document.body.removeChild(containerDiv);
                        }

                        if (widget.pendingUpdate) {
                            cancelAnimationFrame(widget.pendingUpdate);
                            widget.pendingUpdate = null;
                        }
                    };
                }
            } else {

                if (DEBUG) console.log("[PromptWidget]🎉标准模式");

                if (widget.element && inputWidget.inputEl.parentElement) {

                    let container = inputWidget.inputEl.parentElement;


                    if (window.getComputedStyle(container).position === 'static') {
                        container.style.position = 'relative';
                    }


                    container.classList.add('multiline-input');


                    Object.assign(widget.element.style, {
                        right: "12px",
                        bottom: "8px",
                        height: "24px",
                        width: "auto",
                        opacity: "0"
                    });


                    container.appendChild(widget.element);


                    void widget.element.offsetWidth;


                    widget.element.classList.add('widget_show');
                }
            }


            if (widget.element) {
                widget.element.setAttribute('data-node-id', nodeId);
                widget.element.setAttribute('data-input-id', inputId);
                widget.element.setAttribute('data-widget-key', widgetKey);
            }


            TranslateManager.instances.set(widgetKey, widget);

            logger.log(`成功为节点 ${nodeId} 创建翻译小部件`);
        } catch (error) {
            logger.error(`为节点 ${nodeId} 创建翻译小部件失败:`, error);
        }
    },


    hideNodeWidgets(node) {
        if (!node) return;

        try {
            const nodeId = String(node.id);


            const nodeWidgets = [];


            TranslateManager.instances.forEach((instance, key) => {
                try {
                    const keyStr = String(key);


                    if (instance.nodeId === nodeId) {
                        nodeWidgets.push(instance);
                        return;
                    }


                    if (keyStr.startsWith(nodeId + '_')) {
                        nodeWidgets.push(instance);
                        return;
                    }


                    if (keyStr === nodeId) {
                        nodeWidgets.push(instance);
                        return;
                    }


                    if (instance.element && instance.element.getAttribute('data-node-id') === nodeId) {
                        nodeWidgets.push(instance);
                    }
                } catch (e) {

                }
            });

            logger.log(`找到节点 ${nodeId} 的 ${nodeWidgets.length} 个小部件需要隐藏`);


            nodeWidgets.forEach(instance => {
                if (!instance || !instance.element) return;

                try {

                    const isVisible = window.getComputedStyle(instance.element).display !== 'none';

                    if (isVisible) {

                        if (instance.isHiding) return;
                        instance.isHiding = true;


                        instance.element.classList.remove('widget_show');


                        instance.element.style.display = 'flex';
                        instance.element.style.opacity = '1';


                        void instance.element.offsetWidth;


                        instance.element.classList.add('widget_hide');


                        if (instance.hideTimeout) {
                            clearTimeout(instance.hideTimeout);
                        }


                        instance.hideTimeout = setTimeout(() => {
                            if (instance.element) {
                                instance.element.style.display = 'none';

                                instance.element.classList.remove('widget_hide');
                                instance.isHiding = false;
                                instance.hideTimeout = null;
                            }
                        }, 350);
                    } else {

                        instance.element.style.display = 'none';
                        instance.element.classList.remove('widget_show', 'widget_hide');
                        instance.isHiding = false;


                        if (instance.hideTimeout) {
                            clearTimeout(instance.hideTimeout);
                            instance.hideTimeout = null;
                        }
                    }
                } catch (error) {
                    logger.error(`隐藏节点 ${nodeId} 的小部件时出错:`, error);
                }
            });
        } catch (error) {
            logger.error(`隐藏节点小部件过程出错:`, error);
        }
    },


    cleanup() {
        logger.info("卸载PromptWidget扩展");


        this.stopPeriodicCleanup();


        TranslateManager.cleanup();


        if (this.styleElement && document.head.contains(this.styleElement)) {
            document.head.removeChild(this.styleElement);
        }

        logger.info("PromptWidget扩展已完全卸载");
    },
};


window.__CLIP_TRANSLATE__ = {
    manager: TranslateManager,
    extension: PromptWidget,
    throttle: THROTTLE
};


app.registerExtension({
    name: "Comfy.PromptWidget",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "PromptWidget") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);


                const statusEl = document.createElement('div');
                statusEl.className = 'clip-translate-status';
                this.statusEl = statusEl;
                this.wrapper.appendChild(statusEl);

                return result;
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                const result = onExecuted?.apply(this, arguments);
                return result;
            };
        }
    },
    async nodeCreated(node) {
        if (node.type !== "PromptWidget") {
            return;
        }


        api.addEventListener("prompt_translate_update", ({ detail }) => {
            if (detail.node_id !== node.id) return;


            const instance = TranslateManager.getInstance(node.id);
            if (!instance || !instance.text_element) {
                logger.warn(`无法找到节点 ${node.id} 的实例或文本元素`);
                return;
            }


            if (detail.status === "translating") {
                const progress = detail.progress;
                if (progress) {

                    TranslateManager.showStatusTip(
                        instance.text_element,
                        'loading',
                        `翻译中... ${progress.current}/${progress.total}`
                    );


                    if (THROTTLE) {
                        THROTTLE.lastRequestTime[node.id] = Date.now();
                    }
                }
            } else if (detail.status === "success") {
                const operationType = detail.operation_type || "translate";
                const fromCache = detail.from_cache || false;

                if (operationType === "restore") {

                    TranslateManager.showStatusTip(
                        instance.text_element,
                        'restore',
                        detail.operation_desc || "已恢复"
                    );
                } else {

                    const cacheInfo = fromCache ? "(缓存)" : "";
                    const statusText = detail.translate_direction ?
                        `${detail.translate_direction}完成${cacheInfo}` :
                        (fromCache ? "使用缓存翻译" : "翻译完成");

                    TranslateManager.showStatusTip(
                        instance.text_element,
                        'success',
                        statusText
                    );
                }
            } else if (detail.status === "error") {
                TranslateManager.showStatusTip(
                    instance.text_element,
                    'error',
                    `错误: ${detail.message}`
                );
            }
        });
    }
});


if (!app.extensions.find(ext => ext.name === EXTENSION_NAME)) {
    app.registerExtension({
        name: EXTENSION_NAME,
        nodes: PromptWidget.nodes,


        async setup() {

            PromptWidget.initialize();


            const originalOnNodeSelectionChange = app.canvas.onNodeSelectionChange;


            app.canvas.onNodeSelectionChange = function(node, fSelected) {

                if (!FEATURES.enabled) {
                    if (originalOnNodeSelectionChange) {
                        originalOnNodeSelectionChange.call(app.canvas, node, fSelected);
                    }
                    return;
                }


                if (originalOnNodeSelectionChange) {
                    originalOnNodeSelectionChange.call(app.canvas, node, fSelected);
                }


                if (fSelected) {
                    PromptWidget.checkAndSetupNode(node);
                } else {

                    PromptWidget.hideNodeWidgets(node);


                    if (node && node.id) {

                        setTimeout(() => {

                            if (FEATURES.enabled && TranslateManager.isEmptyInstance(node.id) &&
                                (!app.canvas.selected_nodes || !app.canvas.selected_nodes.includes(node))) {
                                logger.log(`节点 ${node.id} 取消选中且实例为空，执行清理`);
                                TranslateManager.cleanup(node.id);
                                logger.info(`[PromptWidget]节点 ${node.id} 已清理，当前剩余 ${TranslateManager.instances.size} 个实例`);
                            }
                        }, 500);
                    }
                }
            };


            const handleGlobalClick = (e) => {

                if (!FEATURES.enabled) return;

                if (e.target && e.target.tagName &&
                    !e.target.closest(".prompt_widget_box")) {

                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, true);
                    }
                }
            };


            document.addEventListener("click", handleGlobalClick);


            this._handleGlobalClick = handleGlobalClick;


            const originalGraphToPrompt = app.graphToPrompt;
            app.graphToPrompt = function() {
                const result = originalGraphToPrompt.apply(this, arguments);


                if (result && result.extra && result.extra.ds) {
                    if (!result.extra.ds.offset || !Array.isArray(result.extra.ds.offset)) {
                        result.extra.ds.offset = [0, 0];
                    } else {

                        result.extra.ds.offset = result.extra.ds.offset.map(v =>
                            typeof v === 'number' && !isNaN(v) ? v : 0
                        );

                        while (result.extra.ds.offset.length < 2) {
                            result.extra.ds.offset.push(0);
                        }
                        if (result.extra.ds.offset.length > 2) {
                            result.extra.ds.offset = result.extra.ds.offset.slice(0, 2);
                        }
                    }
                }

                return result;
            };
        },


        async beforeRegisterNodeDef(nodeType, nodeData) {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            const onRemoved = nodeType.prototype.onRemoved;
            const onConfigure = nodeType.prototype.onConfigure;
            const onDrawForeground = nodeType.prototype.onDrawForeground;


            const self = this;


            nodeType.prototype.onNodeCreated = function() {
                const nodeId = this.id;


                const ret = onNodeCreated?.apply(this, arguments);


                self.nodes[nodeId] = this;

                return ret;
            };


            nodeType.prototype.onRemoved = function() {
                let nodeId = null;

                try {

                    nodeId = this?.id || this?.properties?.id || null;

                    if (nodeId) {
                        logger.log(`节点删除: ${nodeId}`);
                    }
                } catch (error) {
                    logger.error("获取节点ID时出错:", error);
                }


                let result;
                try {
                    result = onRemoved?.apply(this, arguments);
                } catch (error) {
                    logger.error("执行原始onRemoved方法时出错:", error);
                }


                try {

                    TranslateManager.cleanupEmptyInstances('nodeDelete');
                } catch (error) {
                    logger.error("节点删除清理过程出错:", error);
                }

                return result;
            };


            nodeType.prototype.onConfigure = function() {
                const nodeId = this.id;
                const ret = onConfigure?.apply(this, arguments);


                self.nodes[nodeId] = this;

                return ret;
            };


            nodeType.prototype.onDrawForeground = function(ctx) {
                try {

                    onDrawForeground?.apply(this, arguments);


                    const isSelected = app.canvas.selected_nodes && app.canvas.selected_nodes[this.id];


                    if (isSelected) {

                        PromptWidget.checkAndSetupNode(this);
                    } else {

                        PromptWidget.hideNodeWidgets(this);
                    }
                } catch (error) {
                    logger.error(`节点 ${this.id} 绘制前景时出错:`, error);
                }
            };
        },


        async beforeExtensionUnload() {
            try {

                if (app.canvas && app.canvas.onNodeSelectionChange) {

                    app.canvas.onNodeSelectionChange = app.canvas._onNodeSelectionChange || null;
                }


                if (this._handleGlobalClick) {
                    document.removeEventListener("click", this._handleGlobalClick);
                    this._handleGlobalClick = null;
                }


                if (orphanWidgetChecker) {
                    orphanWidgetChecker.stop();
                }


                PromptWidget.stopPeriodicCleanup();


                const selectors = [
                    '.prompt_widget_box',
                    '.prompt_widget_status',
                    '.widget_icon_button',
                    '.prompt_history_popup',
                    '.prompt_preset_popup'
                ];


                const removedCount = DOMUtils.batchCleanup(selectors, true);
                logger.log(`扩展卸载时移除了 ${removedCount} 个DOM元素`);


                TranslateManager.cleanup();


                if (PromptWidget.styleElement && document.head.contains(PromptWidget.styleElement)) {
                    document.head.removeChild(PromptWidget.styleElement);
                }

                logger.info("扩展卸载前清理完成");
            } catch (error) {
                logger.error("扩展卸载前清理时出错:", error);
            }
        },

        settings: [
            {
                id: "PromptWidget.Features.Enabled",
                name: " 小部件总开关",
                category: ["✨提示词小部件", " 功能开关", "总开关"],
                type: "boolean",
                defaultValue: true,
                tooltip: "关闭后将完全禁用小部件功能",
                onChange: (value) => {
                    FEATURES.enabled = value;
                    if (!value) {



                        PromptWidget.stopPeriodicCleanup();


                        TranslateManager.cleanup();


                        if (app.canvas) {

                            app.canvas._originalNodeSelectionChange = app.canvas._onNodeSelectionChange;

                            app.canvas._onNodeSelectionChange = function() {};
                        }

                        logger.log("小部件功能已完全禁用，停止所有相关服务");
                    } else {

                        if (FEATURES.areAllFeaturesDisabled()) {
                            app.ui.settings.setSettingValue("PromptWidget.Features.Enabled", false);
                            logger.log("无法启用小部件：所有功能都处于禁用状态");
                            return;
                        }




                        if (app.canvas) {

                            if (app.canvas._originalNodeSelectionChange) {
                                app.canvas._onNodeSelectionChange = app.canvas._originalNodeSelectionChange;
                                delete app.canvas._originalNodeSelectionChange;
                            }
                        }


                        PromptWidget.startPeriodicCleanup();


                        if (app.graph && app.graph.nodes) {
                            app.graph.nodes.forEach(node => {
                                PromptWidget.checkAndSetupNode(node);
                            });
                        }

                        logger.log("小部件功能已启用，恢复所有相关服务");
                    }
                }
            },
            {
                id: "PromptWidget.Features.History",
                name: "启用历史功能",
                category: ["✨提示词小部件", " 功能开关", "历史功能"],
                type: "boolean",
                defaultValue: true,
                tooltip: "控制历史、撤销、重做功能",
                onChange: (value) => {
                    FEATURES.history = value;

                    TranslateManager.instances.forEach((instance) => {
                        if (instance.buttons) {

                            ['history', 'undo', 'redo'].forEach(key => {
                                const button = instance.buttons[key];
                                if (button) {
                                    button.style.display = value ? 'block' : 'none';
                                }
                            });

                            const firstDivider = instance.element?.querySelector('.widget_divider');
                            if (firstDivider) {
                                firstDivider.style.display = value ? 'block' : 'none';
                            }
                        }
                    });

                    FEATURES.updateEnabledState();
                    logger.log(`历史功能已${value ? "启用" : "禁用"}`);
                }
            },
            {
                id: "PromptWidget.Features.Preset",
                name: "启用预设功能",
                category: ["✨提示词小部件", " 功能开关", "预设功能"],
                type: "boolean",
                defaultValue: true,
                tooltip: "控制提示词预设功能",
                onChange: (value) => {
                    FEATURES.preset = value;

                    TranslateManager.instances.forEach((instance) => {
                        if (instance.buttons?.preset) {
                            instance.buttons.preset.style.display = value ? 'block' : 'none';
                        }
                    });

                    FEATURES.updateEnabledState();
                    logger.log(`预设功能已${value ? "启用" : "禁用"}`);
                }
            },
            {
                id: "PromptWidget.Features.Expand",
                name: "启用扩写功能",
                category: ["✨提示词小部件", " 功能开关", "扩写功能"],
                type: "boolean",
                defaultValue: true,
                tooltip: "控制文本扩写功能",
                onChange: (value) => {
                    FEATURES.expand = value;

                    TranslateManager.instances.forEach((instance) => {
                        if (instance.buttons?.expand) {
                            instance.buttons.expand.style.display = value ? 'block' : 'none';
                        }
                    });

                    FEATURES.updateEnabledState();
                    logger.log(`扩写功能已${value ? "启用" : "禁用"}`);
                }
            },
            {
                id: "PromptWidget.Features.Translate",
                name: "启用翻译功能",
                category: ["✨提示词小部件", " 功能开关", "翻译功能"],
                type: "boolean",
                defaultValue: true,
                tooltip: "控制文本翻译功能",
                onChange: (value) => {
                    FEATURES.translate = value;

                    TranslateManager.instances.forEach((instance) => {
                        if (instance.buttons?.translate) {
                            instance.buttons.translate.style.display = value ? 'block' : 'none';
                        }
                    });

                    FEATURES.updateEnabledState();
                    logger.log(`翻译功能已${value ? "启用" : "禁用"}`);
                }
            },
            {
                id: "PromptWidget.PresetManagement",
                name: "提示词预设词库管理",
                category: ["✨提示词小部件", "  预设管理"],
                type: () => {
                    const row = document.createElement("tr");
                    row.className = "promptwidget-settings-row";

                    const labelCell = document.createElement("td");
                    labelCell.className = "comfy-menu-label";
                    row.appendChild(labelCell);

                    const buttonCell = document.createElement("td");
                    const button = document.createElement("button");
                    button.className = "preset-manager-button";
                    button.textContent = "打开管理界面";
                    button.onclick = () => {
                        try {
                            if (DEBUG) console.log("点击了管理提示词预设按钮");
                            showPresetManagerDialog();
                        } catch (error) {
                            console.error("点击管理提示词预设按钮出错:", error);
                            alert(`打开预设管理器出错: ${error.message}`);
                        }
                    };
                    buttonCell.appendChild(button);
                    row.appendChild(buttonCell);
                    return row;
                }
            },
            {
                id: "PromptWidget.APIConfig",
                name: "配置百度翻译和LLM key",
                category: ["✨提示词小部件", " 翻译和扩写"],
                type: () => {
                    const row = document.createElement("tr");
                    row.className = "promptwidget-settings-row";

                    const labelCell = document.createElement("td");
                    labelCell.className = "comfy-menu-label";
                    row.appendChild(labelCell);

                    const buttonCell = document.createElement("td");
                    const button = document.createElement("button");
                    button.className = "preset-manager-button";
                    button.textContent = "打开配置界面";
                    button.onclick = () => {
                        try {
                            if (DEBUG) console.log("点击了配置API按钮");
                            showAPIConfigDialog();
                        } catch (error) {
                            console.error("点击配置API按钮出错:", error);
                            alert(`打开API配置器出错: ${error.message}`);
                        }
                    };
                    buttonCell.appendChild(button);
                    row.appendChild(buttonCell);
                    return row;
                }
            },
            {
                id: "PromptWidget.Debug.Frontend",
                name: "前端调试日志",
                category: ["✨提示词小部件", "调试选项", "前端"],
                type: "hidden",
                defaultValue: false,
                tooltip: "无需开启，遇到bug排查用的",
                onChange: (value) => {
                    DEBUG = value;
                    logger.log("前端调试模式已" + (value ? "启用" : "禁用"));
                }
            },
            {
                id: "PromptWidget.Debug.Backend",
                name: "后端调试日志",
                category: ["✨提示词小部件", "调试选项", "后端"],
                type: "boolean",
                defaultValue: false,
                tooltip: "无需开启，遇到bug排查用的",
                onChange: async (value) => {
                    try {
                        const response = await fetch('/prompt_widget/set_debug', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ debug: value })
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }

                        const result = await response.json();
                        if (result.status === "success") {
                            logger.log("后端调试模式已" + (value ? "启用" : "禁用"));
                        } else {
                            throw new Error(result.message || "更新失败");
                        }
                    } catch (error) {
                        console.error("设置后端调试模式失败:", error);

                        app.ui.settings.setSettingValue("PromptWidget.Debug.Backend", !value);
                    }
                }
            },
            {
                id: "PromptWidget.Cleanup.Interval",
                name: "小部件清理间隔",
                category: ["✨提示词小部件", "调试选项", "性能"],
                type: "number",
                defaultValue: 60,
                min: 30,
                max: 120,
                step: 1,
                tooltip: "设置自动清理小部件的时间间隔（秒），默认60秒。范围30-120秒",
                attrs: {
                    showButtons: true,
                    maxFractionDigits: 0
                },
                onChange: (value) => {

                    const interval = Math.max(10, Math.min(120, value));


                    if (PromptWidget.cleanupInterval) {
                        clearInterval(PromptWidget.cleanupInterval);
                    }


                    PromptWidget.startPeriodicCleanup(interval * 1000);
                    logger.log(`小部件清理间隔已更新为 ${interval} 秒`);
                }
            },
            {
                id: "PromptWidget.About",
                name: "✨提示词小部件 PromptWidget",
                category: ["✨提示词小部件", " "],
                type: () => {
                    const row = document.createElement("tr");
                    row.className = "promptwidget-settings-row";

                    const labelCell = document.createElement("td");
                    labelCell.className = "comfy-menu-label";
                    row.appendChild(labelCell);

                    const contentCell = document.createElement("td");
                    contentCell.className = "comfy-menu-content";


                    const tagContainer = document.createElement("div");
                    tagContainer.className = "p-tag-container";
                    tagContainer.style.display = "flex";
                    tagContainer.style.alignItems = "center";
                    tagContainer.style.gap = "2px";
                    tagContainer.style.flexWrap = "wrap";


                    const group1 = document.createElement("div");
                    group1.style.display = "flex";
                    group1.style.alignItems = "center";
                    group1.style.gap = "6px";
                    group1.style.flexWrap = "wrap";
                    group1.style.minWidth = "fit-content";


                    const versionBadge = document.createElement("img");
                    versionBadge.alt = "Version";
                    versionBadge.src = `https://img.shields.io/badge/Version-${EXTENSION_VERSION}-green?style=flat`;
                    versionBadge.style.display = "block";
                    versionBadge.style.height = "20px";


                    const authorTag = document.createElement("a");
                    authorTag.href = "https://github.com/yawiii/comfyui_prompt_widget";
                    authorTag.target = "_blank";
                    authorTag.style.textDecoration = "none";
                    authorTag.style.display = "flex";
                    authorTag.style.alignItems = "center";

                    const authorBadge = document.createElement("img");
                    authorBadge.alt = "Static Badge";
                    authorBadge.src = "https://img.shields.io/badge/Github-Yawiii-blue?style=flat&logo=github&logoColor=black&labelColor=%23E1E1E2&color=%2307A3D7";
                    authorBadge.style.display = "block";
                    authorBadge.style.height = "20px";

                    authorTag.appendChild(authorBadge);


                    group1.appendChild(versionBadge);
                    group1.appendChild(authorTag);


                    const divider = document.createElement("div");
                    divider.style.width = "2px";
                    divider.style.height = "20px";
                    divider.style.backgroundColor = "rgba(255, 255, 255, 0.03)";
                    divider.style.margin = "0 10px";
                    divider.style.flexShrink = "0";


                    const group2 = document.createElement("div");
                    group2.style.display = "flex";
                    group2.style.alignItems = "center";
                    group2.style.gap = "5px";
                    group2.style.flexWrap = "wrap";
                    group2.style.minWidth = "fit-content";


                    const tutorialText = document.createElement("span");
                    tutorialText.textContent = "使用教程：";
                    tutorialText.style.color = "#ddd";
                    tutorialText.style.fontSize = "12px";
                    tutorialText.style.whiteSpace = "nowrap";


                    const biliTag = document.createElement("a");
                    biliTag.href = "https://space.bilibili.com/520680644";
                    biliTag.target = "_blank";
                    biliTag.style.textDecoration = "none";
                    biliTag.style.display = "flex";
                    biliTag.style.alignItems = "center";

                    const biliBadge = document.createElement("img");
                    biliBadge.alt = "Bilibili";
                    biliBadge.src = "https://img.shields.io/badge/b%E7%AB%99-%23E1E1E2?style=flat&logo=bilibili&logoColor=%2307A3D7";
                    biliBadge.style.display = "block";
                    biliBadge.style.height = "20px";

                    biliTag.appendChild(biliBadge);


                    const douyinTag = document.createElement("a");
                    douyinTag.href = "https://v.douyin.com/gJnTFSw_tZI/";
                    douyinTag.target = "_blank";
                    douyinTag.style.textDecoration = "none";
                    douyinTag.style.display = "flex";
                    douyinTag.style.alignItems = "center";

                    const douyinBadge = document.createElement("img");
                    douyinBadge.alt = "Douyin";
                    douyinBadge.src = "https://img.shields.io/badge/%E6%8A%96%E9%9F%B3-%23E1E1E2?style=flat&logo=TikTok&logoColor=%23161823";
                    douyinBadge.style.display = "block";
                    douyinBadge.style.height = "20px";

                    douyinTag.appendChild(douyinBadge);


                    group2.appendChild(tutorialText);
                    group2.appendChild(biliTag);
                    group2.appendChild(douyinTag);


                    tagContainer.appendChild(group1);
                    tagContainer.appendChild(divider);
                    tagContainer.appendChild(group2);

                    contentCell.appendChild(tagContainer);
                    row.appendChild(contentCell);

                    return row;
                }
            },
            {
                id: "PromptWidget.Compatibility.Mode",
                name: "开启兼容模式",
                category: ["✨提示词小部件", "调试选项", "兼容性"],
                type: "boolean",
                defaultValue: false,
                tooltip: "若小部件显示位置异常时，尝试打开此选项（需要重启comfyUI）",
                onChange: (value) => {
                    logger.log(`兼容模式已${value ? "启用" : "禁用"}`);
                }
            },
        ],
    });
}


async function showPresetManagerDialog() {
    try {
        if (DEBUG) console.log("正在打开提示词预设管理对话框...");


        hasChanges = false;


        const overlay = document.createElement("div");
        overlay.className = "preset-overlay";
        document.body.appendChild(overlay);


        const dialog = document.createElement("div");
        dialog.className = "prompt-preset-manager-dialog";


        const content = document.createElement("div");
        content.className = "prompt-preset-manager-content";


        const closeButton = document.createElement("button");
        closeButton.className = "preset-close-button";
        closeButton.innerHTML = "&#215;";
        closeButton.onclick = () => handleClose(dialog, overlay);
        content.appendChild(closeButton);


        const title = document.createElement("h2");
        title.className = "prompt-preset-title";
        title.textContent = "提示词预设管理";
        content.appendChild(title);


        const description = document.createElement("p");
        description.textContent = "您可以在这里管理提示词预设，修改后请点击保存按钮。注意：结尾不要加逗号！！";
        description.style.marginBottom = "20px";
        description.style.color = "#aaa";
        content.appendChild(description);


        const loadingIndicator = document.createElement("div");
        loadingIndicator.className = "preset-loading-indicator";
        loadingIndicator.textContent = "正在加载预设数据...";
        content.appendChild(loadingIndicator);


        const tableContainer = document.createElement("div");
        tableContainer.className = "preset-table-container";
        tableContainer.style.display = "none";


        const table = document.createElement("table");
        table.className = "preset-table";


        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");

        ["颜色", "类型", "内容", "说明", "操作"].forEach(headerText => {
            const th = document.createElement("th");
            th.textContent = headerText;
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);


        const tbody = document.createElement("tbody");
        table.appendChild(tbody);

        tableContainer.appendChild(table);
        content.appendChild(tableContainer);


        const footer = document.createElement("div");
        footer.className = "preset-manager-footer";


        const saveButton = document.createElement("button");
        saveButton.className = "preset-save-button";
        saveButton.textContent = "保存";
        saveButton.onclick = () => handleSave(dialog, overlay, tbody);

        footer.appendChild(saveButton);
        content.appendChild(footer);


        dialog.appendChild(content);
        document.body.appendChild(dialog);


        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) {
                handleClose(dialog, overlay);
            }
        });


        try {
            const presets = await loadPresetData();
            await displayPresetData(tbody, presets);


            const inputs = tbody.querySelectorAll('input, select');
            inputs.forEach(input => {
                input.addEventListener('change', trackChanges);
            });


            loadingIndicator.style.display = "none";
            tableContainer.style.display = "block";
            if (DEBUG) console.log("预设数据加载完成");
        } catch (error) {

            loadingIndicator.textContent = `加载失败: ${error.message}`;
            loadingIndicator.style.color = "red";
            if (DEBUG) console.error("预设数据加载失败:", error);
        }
    } catch (error) {
        console.error("创建预设管理对话框时出错:", error);
        showCustomDialog({
            title: "错误",
            content: `创建预设管理对话框时出错: ${error.message}`,
            confirmText: "确定",
            showCancel: false
        });
    }
}


const PRESET_COLORS = {
    blue: { name: "蓝色", color: "rgb(135, 165, 255)" },
    green: { name: "绿色", color: "rgb(120, 255, 120)" },
    red: { name: "红色", color: "rgb(255, 120, 120)" },
    orange: { name: "橙色", color: "rgb(255, 200, 100)" },
    cyan: { name: "青色", color: "rgb(100, 220, 220)" },
    purple: { name: "紫色", color: "rgb(210, 150, 240)" },
    yellow: { name: "黄色", color: "rgb(255, 230, 150)" },
    lightblue: { name: "淡蓝", color: "rgb(160, 200, 255)" },
    pink: { name: "粉色", color: "rgb(240, 180, 240)" },
    lime: { name: "青柠", color: "rgb(140, 220, 140)" },
    coral: { name: "珊瑚", color: "rgb(240, 140, 140)" },
    indigo: { name: "靛蓝", color: "rgb(140, 190, 230)" }
};


async function loadPresetData(tbody) {
    try {

        if (tbody) {
            const presets = [];

            const rows = Array.from(tbody.getElementsByTagName('tr')).slice(0, -1);

            for (const row of rows) {

                const colorSelect = row.querySelector('.preset-color-select');
                const typeSelect = row.querySelector('.preset-type-select');
                const contentInput = row.querySelector('.preset-content-input');
                const noteInput = row.querySelector('.preset-note-input');


                if (contentInput && contentInput.value.trim()) {
                    presets.push({
                        color_type: colorSelect ? colorSelect.value : 'default',
                        type: typeSelect ? typeSelect.value : '未分类',
                        content: contentInput.value.trim(),
                        note: noteInput ? noteInput.value.trim() : ''
                    });
                }
            }

            return presets;
        }


        const response = await fetch('/prompt_widget/presets');
        if (!response.ok) {
            throw new Error(`Failed to load presets: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.presets || [];
    } catch (error) {
        console.error("加载预设数据失败:", error);
        throw error;
    }
}


function movePreset(index, direction, tbody, presets) {
    try {

        const newIndex = index + direction;


        if (newIndex < 0 || newIndex >= presets.length) {
            return false;
        }


        [presets[index], presets[newIndex]] = [presets[newIndex], presets[index]];


        const rows = Array.from(tbody.getElementsByTagName('tr')).slice(0, -1);


        const row1 = rows[index];
        const row2 = rows[newIndex];

        if (!row1 || !row2) {
            console.error("找不到要交换的行:", index, newIndex);
            return false;
        }


        if (direction < 0) {
            tbody.insertBefore(row1, row2);
        }

        else {
            tbody.insertBefore(row2, row1);
        }


        row1.dataset.index = newIndex;
        row2.dataset.index = index;


        updatePresetRows(tbody, presets);

        return true;
    } catch (error) {
        console.error("移动预设时出错:", error);
        return false;
    }
}


function updatePresetRows(tbody, presets) {
    try {

        const rows = Array.from(tbody.getElementsByTagName('tr')).slice(0, -1);

        rows.forEach((row, index) => {

            const moveTopButton = row.querySelector('.move-top-button');
            if (moveTopButton) {
                moveTopButton.disabled = index === 0;
                if (moveTopButton.disabled) {
                    moveTopButton.classList.add('widget_button_disabled');
                } else {
                    moveTopButton.classList.remove('widget_button_disabled');
                }
            }


            const upButton = row.querySelector('.up-button');
            if (upButton) {
                upButton.disabled = index === 0;
                if (upButton.disabled) {
                    upButton.classList.add('widget_button_disabled');
                } else {
                    upButton.classList.remove('widget_button_disabled');
                }
            }


            const downButton = row.querySelector('.down-button');
            if (downButton) {
                downButton.disabled = index === presets.length - 1;
                if (downButton.disabled) {
                    downButton.classList.add('widget_button_disabled');
                } else {
                    downButton.classList.remove('widget_button_disabled');
                }
            }


            row.dataset.index = index;


            if (moveTopButton) {
                moveTopButton.onclick = () => movePresetToTop(index, tbody, presets);
            }
            if (upButton) {
                upButton.onclick = () => movePreset(index, -1, tbody, presets);
            }
            if (downButton) {
                downButton.onclick = () => movePreset(index, 1, tbody, presets);
            }
        });
    } catch (error) {
        console.error("更新预设行状态时出错:", error);
    }
}

function movePresetToTop(index, tbody, presets) {
    try {

        if (index === 0) return false;


        const rows = Array.from(tbody.getElementsByTagName('tr')).slice(0, -1);


        const row = rows[index];
        if (!row) return false;


        const preset = presets.splice(index, 1)[0];
        presets.unshift(preset);


        tbody.insertBefore(row, tbody.firstChild);


        updatePresetRows(tbody, presets);


        trackChanges();

        return true;
    } catch (error) {
        console.error("移动预设到顶部时出错:", error);
        return false;
    }
}

async function displayPresetData(tbody, presets) {
    try {

        tbody.innerHTML = "";

        if (!presets || presets.length === 0) {
            const emptyRow = document.createElement("tr");
            const emptyCell = document.createElement("td");
            emptyCell.colSpan = 5;
            emptyCell.textContent = "没有找到任何预设";
            emptyCell.style.textAlign = "center";
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
            return;
        }


        const presetTypes = new Set();
        presets.forEach(preset => {
            if (preset.type) presetTypes.add(preset.type);
        });
        const availableTypes = Array.from(presetTypes);


        presets.forEach((preset, index) => {
            const row = document.createElement("tr");
            row.dataset.index = index;


            const colorCell = document.createElement("td");
            colorCell.style.width = "30px";
            const colorSelect = document.createElement("select");
            colorSelect.className = "preset-color-select";
            colorSelect.style.width = "30px";
            colorSelect.style.height = "24px";
            colorSelect.title = "选择类型颜色";


            Object.entries(PRESET_COLORS).forEach(([key, value]) => {
                const option = document.createElement("option");
                option.value = key;
                option.textContent = "●";
                option.style.color = value.color;
                option.title = value.name;
                if (preset.color_type === key) {
                    option.selected = true;
                    colorSelect.style.color = value.color;
                }
                colorSelect.appendChild(option);
            });


            if (!preset.color_type) {
                const firstColor = Object.entries(PRESET_COLORS)[0];
                if (firstColor) {
                    preset.color_type = firstColor[0];
                    colorSelect.style.color = firstColor[1].color;
                    colorSelect.value = firstColor[0];
                }
            }

            colorSelect.onchange = (e) => {
                preset.color_type = e.target.value;
                const selectedColor = PRESET_COLORS[e.target.value]?.color;
                if (selectedColor) {
                    e.target.style.color = selectedColor;
                }
                const typeSelect = row.querySelector('.preset-type-select');
                if (typeSelect) {
                    typeSelect.className = `preset-type-select preset_type_${e.target.value}`;
                }
            };

            colorCell.appendChild(colorSelect);
            row.appendChild(colorCell);


            const typeCell = document.createElement("td");
            const typeSelect = document.createElement("select");
            typeSelect.className = `preset-type-select${preset.color_type ? ` preset_type_${preset.color_type}` : ''}`;


            availableTypes.forEach(type => {
                const option = document.createElement("option");
                option.value = type;
                option.textContent = type;
                if (type === preset.type) {
                    option.selected = true;
                }
                typeSelect.appendChild(option);
            });


            const newTypeOption = document.createElement("option");
            newTypeOption.value = "new";
            newTypeOption.textContent = "添加新类型...";
            typeSelect.appendChild(newTypeOption);

            typeSelect.onchange = (e) => handleTypeChange(e.target, preset, newTypeOption);

            typeCell.appendChild(typeSelect);
            row.appendChild(typeCell);


            const contentCell = document.createElement("td");
            const contentInput = document.createElement("input");
            contentInput.type = "text";
            contentInput.className = "preset-content-input";
            contentInput.value = preset.content;
            contentInput.onchange = (e) => {
                preset.content = e.target.value;
            };
            contentCell.appendChild(contentInput);
            row.appendChild(contentCell);


            const noteCell = document.createElement("td");
            const noteInput = document.createElement("input");
            noteInput.type = "text";
            noteInput.className = "preset-note-input";
            noteInput.value = preset.note || "";
            noteInput.onchange = (e) => {
                preset.note = e.target.value;
            };
            noteCell.appendChild(noteInput);
            row.appendChild(noteCell);


            const actionCell = document.createElement("td");
            actionCell.className = "preset-action-buttons";


            const moveTopButton = document.createElement("button");
            moveTopButton.className = "preset-action-button move-top-button";
            moveTopButton.innerHTML = "";
            moveTopButton.title = "移至顶部";
            moveTopButton.onclick = () => movePresetToTop(index, tbody, presets);
            moveTopButton.disabled = index === 0;
            if (moveTopButton.disabled) {
                moveTopButton.classList.add('widget_button_disabled');
            }



            const upButton = document.createElement("button");
            upButton.className = "preset-action-button up-button";
            upButton.innerHTML = "";
            upButton.title = "上移";
            upButton.onclick = () => movePreset(index, -1, tbody, presets);
            upButton.disabled = index === 0;
            if (upButton.disabled) {
                upButton.classList.add('widget_button_disabled');
            }


            const downButton = document.createElement("button");
            downButton.className = "preset-action-button down-button";
            downButton.innerHTML = "";
            downButton.title = "下移";
            downButton.onclick = () => movePreset(index, 1, tbody, presets);
            downButton.disabled = index === presets.length - 1;
            if (downButton.disabled) {
                downButton.classList.add('widget_button_disabled');
            }


            const deleteButton = document.createElement("button");
            deleteButton.className = "preset-action-button delete-button";
            deleteButton.innerHTML = "";
            deleteButton.title = "删除";
            deleteButton.onclick = () => {
                showCustomDialog({
                    title: "确认删除",
                    content: "确定要删除这个预设吗？",
                    confirmText: "确定",
                    cancelText: "取消",
                    onConfirm: () => {
                        presets.splice(index, 1);
                        tbody.removeChild(row);
                        updatePresetRows(tbody, presets);
                        trackChanges();
                    }
                });
            };


            const actionDivider = document.createElement("div");
            actionDivider.className = "preset-action-divider";


            actionCell.appendChild(moveTopButton);
            actionCell.appendChild(upButton);
            actionCell.appendChild(downButton);
            actionCell.appendChild(actionDivider);
            actionCell.appendChild(deleteButton);
            row.appendChild(actionCell);

            tbody.appendChild(row);
        });


        const addRow = document.createElement("tr");
        addRow.className = "preset-add-row";


        const addColorCell = document.createElement("td");
        const addColorSelect = document.createElement("select");
        addColorSelect.className = "preset-color-select";
        addColorSelect.style.width = "30px";
        addColorSelect.style.height = "24px";


        const firstColorEntry = Object.entries(PRESET_COLORS)[0];
        Object.entries(PRESET_COLORS).forEach(([key, value]) => {
            const option = document.createElement("option");
            option.value = key;
            option.textContent = "●";
            option.style.color = value.color;
            option.title = value.name;
            addColorSelect.appendChild(option);
        });


        if (firstColorEntry) {
            addColorSelect.value = firstColorEntry[0];
            addColorSelect.style.color = firstColorEntry[1].color;
        }


        addColorSelect.onchange = (e) => {
            const selectedColor = PRESET_COLORS[e.target.value]?.color;
            if (selectedColor) {
                e.target.style.color = selectedColor;
            }
        };

        addColorCell.appendChild(addColorSelect);
        addRow.appendChild(addColorCell);


        const addTypeCell = document.createElement("td");
        const addTypeSelect = document.createElement("select");
        addTypeSelect.className = "preset-type-select";


        availableTypes.forEach(type => {
            const option = document.createElement("option");
            option.value = type;
            option.textContent = type;
            addTypeSelect.appendChild(option);
        });


        const newTypeOption = document.createElement("option");
        newTypeOption.value = "new";
        newTypeOption.textContent = "添加新类型...";
        addTypeSelect.appendChild(newTypeOption);


        addTypeSelect.onchange = (e) => {
            if (e.target.value === "new") {
                showCustomDialog({
                    title: "添加新类型",
                    content: "请输入新的类型名称：",
                    showInput: true,
                    inputLabel: "类型名称",
                    confirmText: "确定",
                    cancelText: "取消",
                    onConfirm: (newType) => {
                        if (newType && newType.trim()) {
                            const option = document.createElement("option");
                            option.value = newType;
                            option.textContent = newType;
                            e.target.insertBefore(option, newTypeOption);
                            e.target.value = newType;
                        } else {

                            e.target.value = e.target.options[0].value;
                        }
                    },
                    onCancel: () => {

                        e.target.value = e.target.options[0].value;
                    }
                });
            }
        };

        addTypeCell.appendChild(addTypeSelect);
        addRow.appendChild(addTypeCell);


        const addContentCell = document.createElement("td");
        const addContentInput = document.createElement("input");
        addContentInput.type = "text";
        addContentInput.className = "preset-content-input";
        addContentInput.placeholder = "输入预设内容";
        addContentCell.appendChild(addContentInput);
        addRow.appendChild(addContentCell);


        const addNoteCell = document.createElement("td");
        const addNoteInput = document.createElement("input");
        addNoteInput.type = "text";
        addNoteInput.className = "preset-note-input";
        addNoteInput.placeholder = "输入说明";
        addNoteCell.appendChild(addNoteInput);
        addRow.appendChild(addNoteCell);


        const addActionCell = document.createElement("td");
        const addButton = document.createElement("button");
        addButton.className = "preset-add-button";
        addButton.textContent = "添加";
        addButton.onclick = () => {
            const type = addTypeSelect.value;
            const content = addContentInput.value.trim();
            const note = addNoteInput.value.trim();

            if (!content) {
                showCustomDialog({
                    title: "提示",
                    content: "请输入预设内容",
                    confirmText: "确定"
                });
                return;
            }

            if (type === "new") {
                showCustomDialog({
                    title: "添加新类型",
                    content: "请输入新的类型名称：",
                    showInput: true,
                    onConfirm: (newType) => {
                        if (newType) {
                            const newPreset = {
                                type: newType,
                                content: content,
                                note: note,
                                color_type: addColorSelect.value
                            };
                            presets.push(newPreset);
                            displayPresetData(tbody, presets);
                            trackChanges();
                        }
                    }
                });
            } else {
                const newPreset = {
                    type: type,
                    content: content,
                    note: note,
                    color_type: addColorSelect.value
                };
                presets.push(newPreset);
                displayPresetData(tbody, presets);
                trackChanges();
            }
        };
        addActionCell.appendChild(addButton);
        addRow.appendChild(addActionCell);

        tbody.appendChild(addRow);
    } catch (error) {
        console.error("显示预设数据时出错:", error);
        throw error;
    }
}


function showCustomDialog({ title, content, inputLabel, defaultValue = '', confirmText = '确定', cancelText = null, onConfirm, onCancel, showInput = false }) {
    const overlay = document.createElement('div');
    overlay.className = 'custom-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'custom-dialog';

    let input = null;

    dialog.innerHTML = `
        <div class="custom-dialog-title">${title}</div>
        <div class="custom-dialog-content">${content}</div>
        ${showInput ? `
            <div class="custom-dialog-input-group">
                ${inputLabel ? `<label>${inputLabel}</label>` : ''}
                <input type="text" class="custom-dialog-input" value="${defaultValue}">
            </div>
        ` : ''}
        <div class="custom-dialog-buttons">
            ${cancelText ? `<button class="custom-dialog-button secondary">${cancelText}</button>` : ''}
            <button class="custom-dialog-button primary">${confirmText}</button>
        </div>
    `;

    if (showInput) {
        input = dialog.querySelector('.custom-dialog-input');
        input.focus();
    }

    const buttons = dialog.querySelectorAll('button');
    if (cancelText) {
        buttons[0].onclick = () => {
            document.body.removeChild(overlay);
            onCancel?.();
        };
    }

    buttons[cancelText ? 1 : 0].onclick = () => {
        document.body.removeChild(overlay);
        onConfirm?.(input?.value);
    };

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    return overlay;
}


function showSuccessToast(message, duration = 2000) {
    const toast = document.createElement('div');
    toast.className = 'success-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease-in-out forwards';
        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, duration);
}


function handleTypeChange(typeSelect, preset, newTypeOption) {
    if (typeSelect.value === "new") {
        showCustomDialog({
            title: "添加新类型",
            content: "请输入新的类型名称：",
            showInput: true,
            inputLabel: "类型名称",
            confirmText: "确定",
            cancelText: "取消",
            onConfirm: (newType) => {
                if (newType && newType.trim()) {
                    const option = document.createElement("option");
                    option.value = newType;
                    option.textContent = newType;
                    typeSelect.insertBefore(option, newTypeOption);
                    typeSelect.value = newType;
                    if (preset) {
                        preset.type = newType;
                        trackChanges();
                    }
                } else {
                    typeSelect.value = preset ? preset.type : typeSelect.options[0].value;
                }
            },
            onCancel: () => {
                typeSelect.value = preset ? preset.type : typeSelect.options[0].value;
            }
        });
    } else if (preset) {
        preset.type = typeSelect.value;
        trackChanges();
    }
}


let hasChanges = false;

function trackChanges() {
    hasChanges = true;
}


function handleClose(dialog, overlay) {

    if (hasChanges) {
        showCustomDialog({
            title: "确认关闭",
            content: "您有未保存的修改，确定要关闭吗？",
            confirmText: "取消",
            cancelText: "确定",
            onConfirm: () => {

            },
            onCancel: () => {
                document.body.removeChild(dialog);
                document.body.removeChild(overlay);
                hasChanges = false;
            }
        });
    } else {
        document.body.removeChild(dialog);
        document.body.removeChild(overlay);
    }
}


async function handleSave(dialog, overlay, tbody) {
    try {
        const presets = await loadPresetData(tbody);

        const response = await fetch('/prompt_widget/save_presets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ presets })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.message || `保存失败: ${response.status} ${response.statusText}`);
        }

        if (result.status === "success") {

            await TranslateManager.reloadConfig();

            showSuccessToast("保存成功！预设已更新");
            hasChanges = false;
        } else {
            throw new Error(result.message || "保存失败");
        }
    } catch (error) {
        console.error("保存预设失败:", error);
        showCustomDialog({
            title: "保存失败",
            content: error.message,
            confirmText: "确定"
        });
    }
}


async function showAPIConfigDialog() {
    try {
        if (DEBUG) console.log("正在打开API配置对话框...");


        hasChanges = false;


        const overlay = document.createElement("div");
        overlay.className = "preset-overlay";
        document.body.appendChild(overlay);


        const dialog = document.createElement("div");
        dialog.className = "prompt-preset-manager-dialog";


        const content = document.createElement("div");
        content.className = "prompt-preset-manager-content";


        const closeButton = document.createElement("button");
        closeButton.className = "preset-close-button";
        closeButton.innerHTML = "&#215;";
        closeButton.onclick = () => handleClose(dialog, overlay);
        content.appendChild(closeButton);


        const title = document.createElement("h2");
        title.className = "prompt-preset-title";
        title.textContent = "API配置";
        content.appendChild(title);


        const description = document.createElement("p");
        description.textContent = "配置百度翻译和LLM扩写功能的API参数。";
        description.style.marginBottom = "0px";
        content.appendChild(description);


        const loadingIndicator = document.createElement("div");
        loadingIndicator.className = "preset-loading-indicator";
        loadingIndicator.textContent = "正在加载配置数据...";
        content.appendChild(loadingIndicator);


        const formContainer = document.createElement("div");
        formContainer.className = "api-config-container";
        formContainer.style.display = "none";


        const translateSection = document.createElement("div");
        translateSection.className = "api-config-section";

        const translateTitle = document.createElement("h3");
        translateTitle.textContent = "百度翻译配置";
        translateSection.appendChild(translateTitle);


        const translateForm = document.createElement("div");
        translateForm.className = "api-config-form";


        const translateRow = document.createElement("div");
        translateRow.className = "api-config-row";


        const appidGroup = createInputGroup("百度翻译AppID", "appid", "text", "输入百度翻译AppID", null, null, null, "half-width");
        translateRow.appendChild(appidGroup);


        const keyGroup = createInputGroup("百度翻译Key", "key", "text", "输入百度翻译Key", null, null, null, "half-width");
        translateRow.appendChild(keyGroup);

        translateForm.appendChild(translateRow);
        translateSection.appendChild(translateForm);
        formContainer.appendChild(translateSection);


        const llmSection = document.createElement("div");
        llmSection.className = "api-config-section";

        const llmTitle = document.createElement("h3");
        llmTitle.textContent = "LLM扩写配置";
        llmSection.appendChild(llmTitle);


        const llmForm = document.createElement("div");
        llmForm.className = "api-config-form";


        const llmRow1 = document.createElement("div");
        llmRow1.className = "api-config-row";


        const llmKeyGroup = createInputGroup("API Key", "llm_api_key", "text", "输入LLM API Key", null, null, null, "half-width");
        llmRow1.appendChild(llmKeyGroup);


        const apiBaseGroup = createInputGroup("API Base URL", "llm_api_base", "text", "输入API Base URL", null, null, null, "half-width");
        llmRow1.appendChild(apiBaseGroup);

        llmForm.appendChild(llmRow1);


        const llmRow2 = document.createElement("div");
        llmRow2.className = "api-config-row";


        const modelGroup = createInputGroup("模型", "llm_model", "text", "输入模型名称", null, null, null, "model-width");
        llmRow2.appendChild(modelGroup);


        const tempGroup = createInputGroup("Temperature", "llm_temperature", "number", "输入temperature值", "0", "1", "0.1", "quarter-width");
        llmRow2.appendChild(tempGroup);


        const tokensGroup = createInputGroup("Max Tokens", "llm_max_tokens", "number", "输入最大token数", "1", "2000", "1", "quarter-width");
        llmRow2.appendChild(tokensGroup);

        llmForm.appendChild(llmRow2);


        const promptGroup = createInputGroup("System Prompt", "llm_system_prompt", "textarea", "输入系统提示词", null, null, null, "full-width");
        llmForm.appendChild(promptGroup);

        llmSection.appendChild(llmForm);
        formContainer.appendChild(llmSection);

        content.appendChild(formContainer);


        const footer = document.createElement("div");
        footer.className = "api-config-footer";


        const saveButton = document.createElement("button");
        saveButton.className = "api-config-save";
        saveButton.textContent = "保存";
        saveButton.onclick = () => handleSaveConfig(dialog, overlay, formContainer);

        footer.appendChild(saveButton);
        content.appendChild(footer);


        dialog.appendChild(content);
        document.body.appendChild(dialog);


        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) {
                handleClose(dialog, overlay);
            }
        });


        try {
            const config = await loadConfig();


            await new Promise(resolve => setTimeout(resolve, 100));


            await displayConfig(formContainer, config);


            const inputs = formContainer.querySelectorAll('input, textarea');
            inputs.forEach(input => {
                input.addEventListener('change', trackChanges);
            });


            loadingIndicator.style.display = "none";
            formContainer.style.display = "block";
            if (DEBUG) console.log("配置数据加载完成");
        } catch (error) {
            loadingIndicator.textContent = `加载失败: ${error.message}`;
            loadingIndicator.style.color = "red";
            console.error("配置数据加载失败:", error);
        }
    } catch (error) {
        console.error("创建API配置对话框时出错:", error);
        showCustomDialog({
            title: "错误",
            content: `创建API配置对话框时出错: ${error.message}`,
            confirmText: "确定",
            showCancel: false
        });
    }
}


function createInputGroup(label, id, type, placeholder, min, max, step, widthClass = "") {
    const group = document.createElement("div");
    group.className = `api-config-group ${widthClass}`;

    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    labelEl.htmlFor = id;
    group.appendChild(labelEl);

    let input;
    if (type === "textarea") {
        input = document.createElement("textarea");
        input.rows = 4;
    } else {
        input = document.createElement("input");
        input.type = type;
        if (type === "number") {
            input.min = min;
            input.max = max;
            input.step = step;
        }
    }

    input.id = id;
    input.name = id;
    input.className = type === "textarea" ? "api-config-textarea" : "api-config-input";
    input.placeholder = placeholder;
    group.appendChild(input);

    return group;
}


async function loadConfig() {
    try {
        const response = await fetch('/prompt_widget/load_config');
        if (!response.ok) {
            throw new Error(`Failed to load config: ${response.status} ${response.statusText}`);
        }

        const config = await response.json();
        return config;
    } catch (error) {
        console.error("加载配置失败:", error);
        throw error;
    }
}


async function displayConfig(container, config) {
    try {

        if (config.prompt_translate) {
            const appidInput = container.querySelector('#appid');
            const keyInput = container.querySelector('#key');

            if (appidInput) appidInput.value = config.prompt_translate.appid || '';
            if (keyInput) keyInput.value = config.prompt_translate.key || '';
        }


        if (config.llm_expand) {
            const inputs = {
                'llm_api_key': config.llm_expand.api_key || '',
                'llm_api_base': config.llm_expand.api_base || 'https://api.openai.com/v1',
                'llm_model': config.llm_expand.model || 'gpt-3.5-turbo',
                'llm_temperature': config.llm_expand.temperature || 0.7,
                'llm_max_tokens': config.llm_expand.max_tokens || 1000,
                'llm_system_prompt': config.llm_expand.system_prompt || ''
            };


            Object.entries(inputs).forEach(([id, value]) => {
                const input = container.querySelector(`#${id}`);
                if (input) {
                    input.value = value;
                } else {
                    console.warn(`找不到ID为 ${id} 的输入框`);
                }
            });
        }
    } catch (error) {
        console.error("显示配置数据时出错:", error);
        throw error;
    }
}


async function handleSaveConfig(dialog, overlay, container) {
    try {
        const config = {
            prompt_translate: {
                appid: container.querySelector('#appid').value,
                key: container.querySelector('#key').value
            },
            llm_expand: {
                api_key: container.querySelector('#llm_api_key').value,
                api_base: container.querySelector('#llm_api_base').value,
                model: container.querySelector('#llm_model').value,
                temperature: parseFloat(container.querySelector('#llm_temperature').value),
                max_tokens: parseInt(container.querySelector('#llm_max_tokens').value),
                system_prompt: container.querySelector('#llm_system_prompt').value
            }
        };

        const response = await fetch('/prompt_widget/save_config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.message || `保存失败: ${response.status} ${response.statusText}`);
        }

        if (result.status === "success") {

            await TranslateManager.reloadConfig();

            showSuccessToast("保存成功！配置已更新");
            hasChanges = false;


            document.body.removeChild(dialog);
            document.body.removeChild(overlay);
        } else {
            throw new Error(result.message || "保存失败");
        }
    } catch (error) {
        console.error("保存配置失败:", error);
        showCustomDialog({
            title: "保存失败",
            content: error.message,
            confirmText: "确定"
        });
    }
}


