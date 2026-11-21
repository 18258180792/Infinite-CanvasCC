// smart-canvas-agent.js — LibTV Inline-Token Agent + Node Outline + Lineage + Star Favorites + Multi-Model Compare
(function () {
    'use strict';

    const AGENT_SETTINGS_KEY = 'smart_canvas_agent_settings_v2';
    const AGENT_THREADS_PREFIX = 'smart_canvas_agent_threads_v2_';
    const GPT_CHAT_SETTINGS_KEY = 'gpt_chat_settings_v1';

    const RATIO_KEY_TO_LABEL = {
        square: '1:1',
        portrait: '2:3',
        landscape: '3:2',
        portrait43: '3:4',
        landscape43: '4:3',
        story: '9:16',
        wide: '16:9',
        ultrawide: '21:9'
    };

    const LABEL_TO_RATIO_KEY = {
        '1:1': 'square',
        '2:3': 'portrait',
        '3:2': 'landscape',
        '3:4': 'portrait43',
        '4:3': 'landscape43',
        '9:16': 'story',
        '16:9': 'wide',
        '21:9': 'ultrawide',
        '9:21': 'ultratall'
    };

    const MS_AGENT_IMAGE_MODELS = [
        { id: 'klein_edit', name: 'FLUX.2 Klein 9B (MS)' },
        { id: 'qwen_edit', name: 'Qwen Image Edit (MS)' },
        { id: 'zimage', name: 'Z-Image Turbo (MS)' }
    ];

    const CLIENT_AGENT_PROTOCOL = [
        '\n\n# 当前运行环境：智能无限画布（Smart Infinite Canvas）创作 Agent',
        '当前环境已内置并获用户授权使用「画布节点自动连线与新建生图节点」能力。用户在句子中内嵌引用的节点（如 `@[图1：节点名 (node_id=...)]`）及画布关联节点均带有唯一 `node_id`。',
        '\n## 决策与执行规则',
        '1. **何时创建生图节点（`action: "create_generation_node"`）**：',
        '   - 当用户提出生图、改图、换背景、替换产品/人物/服装/材质、多图融合、风格迁移、扩图、调光调色、基于生成结果继续微调，或批量衍生画面等明确目标时，必须规划生图任务。',
        '   - 当用户只是打招呼、询问角色、要求「仅反推提示词不要生图」、尚未给出修改方向，或关键信息严重缺失必须先提问澄清时，使用 `action: "chat"`（`tasks` 为 `[]`）。',
        '2. **自动挑选所需节点与行内「图片 1 / 图片 2」胶囊对齐（极其重要）**：',
        '   - 从候选节点中精准挑选**真正需要连接**的 `node_id` 放入 `source_node_ids`（纯文生图填 `[]`）。',
        '   - **迭代改图防失真规则**：当用户引用某张「画布已生成结果节点」微调细节/颜色/文字，且候选列表中附带了它的「上游原始参考源节点」（最初的高清产品图、原场景图）时，请按需将**当前生成节点 + 关键上游原始参考源节点**一并放入 `source_node_ids`，防止多轮改图偏色或文字模糊！',
        '   - 下游生图节点严格按 `source_node_ids` 顺序映射为 `图片 1`、`图片 2`、`图片 3`……并自动渲染为行内缩略图胶囊。因此当 `source_node_ids` 非空时，必须在 `prompt` 正文中显式用 `图片 1`、`图片 2` 指代对应参考图！',
        '3. **简洁回复风格与末尾 `<agent_plan>` 输出格式**：',
        '   - 对话框正文保持像专业导演助手一样简洁自然（1～4 句话讲清修改方案即可；勿声称“已生成完成”）。',
        '   - 为每个新建节点起一个有辨识度的中文短标题 `title`（6～16 字）。',
        '   - 在回复**最末尾**输出且仅输出一个 `<agent_plan>...</agent_plan>` 标签包裹的合法 JSON：',
        '<agent_plan>',
        '{',
        '  "action": "create_generation_node",',
        '  "reply": "一句话说明方案",',
        '  "tasks": [',
        '    {',
        '      "title": "有辨识度的短标题",',
        '      "source_node_ids": ["实际node_id_1", "实际node_id_2"],',
        '      "prompt": "包含 图片 1、图片 2 明确指代、完整独立可用的最终生图提示词（不含代码块标记）",',
        '      "aspect_ratio": "可选：1:1 / 2:3 / 3:2 / 3:4 / 4:3 / 9:16 / 16:9 / 21:9 或空字符串"',
        '    }',
        '  ]',
        '}',
        '</agent_plan>',
        '   - 若本次不创建生图节点，末尾输出：<agent_plan>{"action":"chat","reply":"","tasks":[]}</agent_plan>'
    ].join('\n');

    function readJsonStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeJsonStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    function readGptChatSettings() {
        return readJsonStorage(GPT_CHAT_SETTINGS_KEY, {});
    }

    const AGENT_LAYOUT_DEFAULTS = {
        dockWidthMin: 340,
        dockWidthMax: 580,
        dockWidthDefault: 404,
        floatMinW: 340,
        floatMaxW: 620,
        floatDefaultW: 396,
        floatMinH: 420,
        floatDefaultH: 640,
        dockSnapPointerMargin: 52,
        dockSnapEdgeMargin: 26,
        edgeMagnetThreshold: 24,
        safeTop: 56,
        safeGutter: 14
    };

    function clampAgentDockWidth(rawWidth) {
        const n = Number(rawWidth);
        if (!Number.isFinite(n) || n <= 0) return AGENT_LAYOUT_DEFAULTS.dockWidthDefault;
        return Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.dockWidthMin, Math.min(AGENT_LAYOUT_DEFAULTS.dockWidthMax, n)));
    }

    function normalizeAgentFloatRect(rawRect, viewportW = (typeof window !== 'undefined' ? window.innerWidth : 1280), viewportH = (typeof window !== 'undefined' ? window.innerHeight : 800)) {
        const vw = Math.max(360, Number(viewportW) || 1280);
        const vh = Math.max(480, Number(viewportH) || 800);
        const maxW = Math.min(AGENT_LAYOUT_DEFAULTS.floatMaxW, Math.max(AGENT_LAYOUT_DEFAULTS.floatMinW, vw - 24));
        const minH = Math.min(AGENT_LAYOUT_DEFAULTS.floatMinH, Math.max(280, vh - 72));
        const maxH = Math.max(minH, vh - 72);
        const defaultH = Math.min(AGENT_LAYOUT_DEFAULTS.floatDefaultH, Math.max(minH, vh - 136));

        const width = Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.floatMinW, Math.min(maxW, Number(rawRect?.width) || AGENT_LAYOUT_DEFAULTS.floatDefaultW)));
        const height = Math.round(Math.max(minH, Math.min(maxH, Number(rawRect?.height) || defaultH)));
        const fallbackLeft = Math.max(AGENT_LAYOUT_DEFAULTS.safeGutter, vw - width - 34);
        const fallbackTop = Math.max(AGENT_LAYOUT_DEFAULTS.safeTop, Math.min(78, vh - height - AGENT_LAYOUT_DEFAULTS.safeGutter));

        const rawLeft = Number(rawRect?.left);
        const rawTop = Number(rawRect?.top);
        const maxLeft = Math.max(AGENT_LAYOUT_DEFAULTS.safeGutter, vw - width - 12);
        const maxTop = Math.max(AGENT_LAYOUT_DEFAULTS.safeTop, vh - height - AGENT_LAYOUT_DEFAULTS.safeGutter);
        const left = Math.round(Math.max(10, Math.min(maxLeft, Number.isFinite(rawLeft) ? rawLeft : fallbackLeft)));
        const top = Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.safeTop, Math.min(maxTop, Number.isFinite(rawTop) ? rawTop : fallbackTop)));

        return { left, top, width, height };
    }

    function computeAgentFloatSnap(rect, pointerX, viewportW, viewportH, options = {}) {
        const vw = Math.max(360, Number(viewportW) || 1280);
        const vh = Math.max(480, Number(viewportH) || 800);
        const minW = options.minWidth || 340;
        const maxW = Math.min(options.maxWidth || 620, Math.max(minW, vw - 24));
        const minH = Math.min(options.minHeight || 420, Math.max(280, vh - 72));
        const maxH = Math.max(minH, vh - 72);

        const width = Math.round(Math.max(minW, Math.min(maxW, Number(rect?.width) || 396)));
        const height = Math.round(Math.max(minH, Math.min(maxH, Number(rect?.height) || 640)));

        const dockEnabled = vw >= 720 && options.allowDock !== false;
        const pointerMargin = options.dockSnapPointerMargin ?? 52;
        const edgeMargin = options.dockSnapEdgeMargin ?? 26;
        const magnet = options.edgeMagnetThreshold ?? 24;
        const safeTop = options.safeTop ?? 56;
        const safeGutter = options.safeGutter ?? 14;

        const rawLeft = Number(rect?.left);
        const rawTop = Number(rect?.top);
        let left = Number.isFinite(rawLeft) ? rawLeft : Math.max(safeGutter, vw - width - 34);
        let top = Number.isFinite(rawTop) ? rawTop : Math.max(safeTop, Math.min(78, vh - height - safeGutter));

        const maxLeft = Math.max(safeGutter, vw - width - 10);
        const maxTop = Math.max(safeTop, vh - height - safeGutter);
        left = Math.max(10, Math.min(maxLeft, left));
        top = Math.max(safeTop, Math.min(maxTop, top));

        const px = Number.isFinite(pointerX) ? pointerX : (left + width);
        const shouldDock = dockEnabled && (px >= vw - pointerMargin || (left + width) >= vw - edgeMargin);

        const snappedEdges = [];
        if (!shouldDock) {
            if (left <= safeGutter + magnet) {
                left = safeGutter;
                snappedEdges.push('left');
            }
            if (top <= safeTop + magnet) {
                top = safeTop;
                snappedEdges.push('top');
            } else if (vh - (top + height) <= safeGutter + magnet && maxTop >= safeTop) {
                top = maxTop;
                snappedEdges.push('bottom');
            }
        }

        return {
            shouldDock,
            left: Math.round(left),
            top: Math.round(top),
            width,
            height,
            snappedEdges
        };
    }

    function formatAgentInlineMarkdown(escapedLine) {
        return String(escapedLine || '')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }

    function renderAgentFormattedText(el, rawText) {
        if (!el) return;
        const src = String(rawText || '');
        if (!src) {
            el.innerHTML = '';
            return;
        }
        const parts = src.split(/```/);
        const htmlParts = [];
        for (let idx = 0; idx < parts.length; idx++) {
            if (idx % 2 === 1) {
                const code = parts[idx].replace(/^[a-zA-Z0-9_-]*\r?\n/, '');
                htmlParts.push(`<pre class="sa-code-block"><code>${escapeHtml(code)}</code></pre>`);
                continue;
            }
            const lines = parts[idx].split(/\r?\n/);
            let inList = false;
            let listTag = 'ul';
            let paraLines = [];
            const flushPara = () => {
                if (!paraLines.length) return;
                htmlParts.push(`<p>${paraLines.map(l => formatAgentInlineMarkdown(escapeHtml(l))).join('<br>')}</p>`);
                paraLines = [];
            };
            const flushList = () => {
                if (!inList) return;
                htmlParts.push(`</${listTag}>`);
                inList = false;
            };
            lines.forEach(line => {
                const trimmed = line.trim();
                const ulMatch = trimmed.match(/^[-•*]\s+(.+)$/);
                const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
                if (!trimmed) {
                    flushPara();
                    flushList();
                } else if (ulMatch) {
                    flushPara();
                    if (!inList || listTag !== 'ul') {
                        flushList();
                        htmlParts.push('<ul>');
                        inList = true;
                        listTag = 'ul';
                    }
                    htmlParts.push(`<li>${formatAgentInlineMarkdown(escapeHtml(ulMatch[1]))}</li>`);
                } else if (olMatch) {
                    flushPara();
                    if (!inList || listTag !== 'ol') {
                        flushList();
                        htmlParts.push('<ol>');
                        inList = true;
                        listTag = 'ol';
                    }
                    htmlParts.push(`<li>${formatAgentInlineMarkdown(escapeHtml(olMatch[1]))}</li>`);
                } else {
                    flushList();
                    paraLines.push(line);
                }
            });
            flushPara();
            flushList();
        }
        el.innerHTML = htmlParts.join('');
    }
    /* ===== End Pure Agent Helpers ===== */

    const gptInitial = readGptChatSettings();
    const savedAgent = readJsonStorage(AGENT_SETTINGS_KEY, {});
    const initialFloatRect = (savedAgent.floatRect && typeof savedAgent.floatRect === 'object')
        ? normalizeAgentFloatRect(savedAgent.floatRect)
        : (savedAgent.panelPos && typeof savedAgent.panelPos === 'object' ? normalizeAgentFloatRect(savedAgent.panelPos) : null);

    const state = {
        open: Boolean(savedAgent.open),
        layoutMode: savedAgent.layoutMode === 'floating' ? 'floating' : 'docked',
        dockWidth: clampAgentDockWidth(savedAgent.dockWidth),
        floatRect: initialFloatRect,
        sending: false,
        abortController: null,
        serverStreamSupported: null,
        modelScopeTab: 'image',
        chatProvider: savedAgent.chatProvider || gptInitial.provider || '',
        chatModel: savedAgent.chatModel || gptInitial.activeChatModel || '',
        imageProvider: savedAgent.imageProvider || gptInitial.activeImageProvider || '',
        imageModel: savedAgent.imageModel || gptInitial.activeImageModel || '',
        compareMode: Boolean(savedAgent.compareMode),
        compareTargets: Array.isArray(savedAgent.compareTargets) ? savedAgent.compareTargets : [], // [{provider, model}]
        sizeMode: ['auto', 'preset', 'custom'].includes(savedAgent.sizeMode) ? savedAgent.sizeMode : 'auto',
        ratioKey: RATIO_KEY_TO_LABEL[savedAgent.ratioKey] ? savedAgent.ratioKey : 'square',
        resTier: ['1k', '2k', '4k'].includes(savedAgent.resTier) ? savedAgent.resTier : '2k',
        customW: Number(savedAgent.customW) || 1024,
        customH: Number(savedAgent.customH) || 1024,
        autoRun: savedAgent.autoRun !== false,
        clickToRef: savedAgent.clickToRef !== false,
        promptSource: savedAgent.promptSource || 'gpt',
        customSystemPrompt: typeof savedAgent.customSystemPrompt === 'string' ? savedAgent.customSystemPrompt : '',
        skillIds: Array.isArray(savedAgent.skillIds)
            ? savedAgent.skillIds.map(String)
            : (Array.isArray(gptInitial.chatSkillIds) ? gptInitial.chatSkillIds.map(String) : []),
        skillFilterTab: 'all',
        skillSearchQuery: '',
        orbPos: savedAgent.orbPos || null,
        panelPos: savedAgent.panelPos || null,
        threads: [],
        currentThreadId: '',
        savedCaretRange: null,
        mentionOpen: false,
        mentionAtRange: null,
        mentionQuery: '',
        mentionActiveIdx: 0,
        outlineOpen: false,
        outlineTab: 'all', // 'all' | 'starred' | 'generated' | 'source' | 'other'
        outlineQuery: '',
        msChatModels: []
    };

    let els = {};

    function saveAgentSettings() {
        writeJsonStorage(AGENT_SETTINGS_KEY, {
            open: state.open,
            layoutMode: state.layoutMode,
            dockWidth: state.dockWidth,
            floatRect: state.floatRect,
            chatProvider: state.chatProvider,
            chatModel: state.chatModel,
            imageProvider: state.imageProvider,
            imageModel: state.imageModel,
            compareMode: state.compareMode,
            compareTargets: state.compareTargets.slice(0, 4),
            sizeMode: state.sizeMode,
            ratioKey: state.ratioKey,
            resTier: state.resTier,
            customW: state.customW,
            customH: state.customH,
            autoRun: state.autoRun,
            clickToRef: state.clickToRef,
            promptSource: state.promptSource,
            customSystemPrompt: state.customSystemPrompt,
            skillIds: state.skillIds,
            orbPos: state.orbPos,
            panelPos: state.panelPos
        });
    }

    function threadsStorageKey() {
        const cid = (typeof canvas !== 'undefined' && canvas?.id) || (typeof canvasId !== 'undefined' && canvasId) || 'global';
        return AGENT_THREADS_PREFIX + cid;
    }

    function loadThreads() {
        const list = readJsonStorage(threadsStorageKey(), []);
        state.threads = Array.isArray(list) ? list : [];
        if (!state.threads.length) state.threads = [createEmptyThread()];
        if (!state.threads.some(t => t.id === state.currentThreadId)) {
            state.currentThreadId = state.threads[0].id;
        }
    }

    function saveThreads() {
        const trimmed = state.threads.slice(0, 25).map(t => ({
            id: t.id,
            title: t.title || '新对话',
            updatedAt: t.updatedAt || Date.now(),
            messages: (t.messages || []).slice(-40)
        }));
        writeJsonStorage(threadsStorageKey(), trimmed);
    }

    function createEmptyThread() {
        return {
            id: 'sat_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
            title: '新对话',
            updatedAt: Date.now(),
            messages: []
        };
    }

    function currentThread() {
        let t = state.threads.find(item => item.id === state.currentThreadId);
        if (!t) {
            t = createEmptyThread();
            state.threads.unshift(t);
            state.currentThreadId = t.id;
        }
        return t;
    }

    /* ===== System Prompt & Presets ===== */
    function allPromptLibraryPresets() {
        const libs = (typeof promptLibraries !== 'undefined' && Array.isArray(promptLibraries)) ? promptLibraries : [];
        const items = [];
        libs.forEach(lib => {
            (lib.items || []).forEach(it => {
                const text = String(it?.positive || '').trim();
                if (!text || text === '新提示词') return;
                items.push({
                    id: String(it.id),
                    name: String(it.name || '未命名预设').trim(),
                    category: String(it.category || ''),
                    text
                });
            });
        });
        items.sort((a, b) => {
            const score = item => {
                if (/系统提示词|agent|专家/i.test(item.name)) return 0;
                if (item.category === 'custom' || item.category === 'edit') return 1;
                return 2;
            };
            return score(a) - score(b);
        });
        return items;
    }

    function effectiveAgentSystemPrompt() {
        if (state.promptSource === 'gpt') {
            const latestGpt = readGptChatSettings();
            const gptPrompt = String(latestGpt.systemPrompt || '').trim();
            if (gptPrompt) return gptPrompt;
            const expert = allPromptLibraryPresets().find(p => /系统提示词/.test(p.name));
            return expert ? expert.text : '';
        }
        if (state.promptSource.startsWith('preset:')) {
            const pid = state.promptSource.slice(7);
            const found = allPromptLibraryPresets().find(p => p.id === pid);
            if (found) return found.text;
        }
        return String(state.customSystemPrompt || '').trim();
    }

    function effectiveSkillIds() {
        return Array.isArray(state.skillIds) ? state.skillIds : [];
    }

    function promptSourceLabel() {
        if (state.promptSource === 'gpt') {
            const latestGpt = readGptChatSettings();
            if (String(latestGpt.systemPrompt || '').trim()) return '已同步：Agent智能改图系统提示词';
            const expert = allPromptLibraryPresets().find(p => /系统提示词/.test(p.name));
            return expert ? `自动带入：${expert.name}` : '默认创作系统提示词';
        }
        if (state.promptSource.startsWith('preset:')) {
            const pid = state.promptSource.slice(7);
            const found = allPromptLibraryPresets().find(p => p.id === pid);
            return found ? `预设：${found.name}` : '预设系统提示词';
        }
        return state.customSystemPrompt.trim() ? '画布独立自定义系统提示词' : '未设置自定义系统提示词';
    }

    /* ===== Provider & Multi-Model Helpers ===== */
    function availableChatProviders() {
        const raw = (typeof chatApiProviders === 'function' ? chatApiProviders() : []).map(p => ({
            id: p.id,
            name: p.name || p.id,
            primary: Boolean(p.primary),
            models: [...new Set(p.chat_models || [])]
        }));
        if (state.msChatModels.length && !raw.some(p => p.id === 'modelscope')) {
            raw.push({ id: 'modelscope', name: 'ModelScope', primary: false, models: state.msChatModels.slice() });
        }
        raw.sort((a, b) => {
            if (a.primary !== b.primary) return a.primary ? -1 : 1;
            return (a.id === 'modelscope' ? 1 : 0) - (b.id === 'modelscope' ? 1 : 0);
        });
        return raw;
    }

    function availableImageProviders() {
        const out = [];
        const apiList = typeof imageProviders === 'function' ? imageProviders() : [];
        apiList.forEach(p => {
            const models = [...new Set(p.image_models || [])];
            if (models.length) out.push({ id: p.id, name: p.name || p.id, engine: 'api', models });
        });
        if (typeof volcengineProvider === 'function') {
            const volc = volcengineProvider();
            const vModels = [...new Set(volc?.image_models || [])];
            if (vModels.length) out.push({ id: 'volcengine', name: volc.name || '火山引擎', engine: 'volcengine', models: vModels });
        }
        out.push({
            id: 'modelscope',
            name: 'ModelScope 生图',
            engine: 'modelscope',
            models: MS_AGENT_IMAGE_MODELS.map(m => m.id)
        });
        return out;
    }

    function ensureValidModels() {
        const cProviders = availableChatProviders();
        if (cProviders.length) {
            if (!cProviders.some(p => p.id === state.chatProvider)) state.chatProvider = cProviders[0].id;
            const cModels = cProviders.find(p => p.id === state.chatProvider)?.models || [];
            if (cModels.length && !cModels.includes(state.chatModel)) {
                state.chatModel = cModels.find(m => /6\.1|vl|gpt-5|4o|gemini|claude/i.test(m)) || cModels[0];
            }
        }
        const iProviders = availableImageProviders();
        if (iProviders.length) {
            if (!iProviders.some(p => p.id === state.imageProvider)) {
                const canvasPid = (typeof settings !== 'undefined' && settings?.provider_id) || '';
                state.imageProvider = iProviders.some(p => p.id === canvasPid) ? canvasPid : iProviders[0].id;
            }
            const iModels = iProviders.find(p => p.id === state.imageProvider)?.models || [];
            if (iModels.length && !iModels.includes(state.imageModel)) {
                const canvasMdl = (typeof settings !== 'undefined' && settings?.model) || '';
                state.imageModel = iModels.includes(canvasMdl) ? canvasMdl : iModels[0];
            }
            // Validate compareTargets
            state.compareTargets = (state.compareTargets || []).filter(ct => {
                const p = iProviders.find(x => x.id === ct.provider);
                return p && p.models.includes(ct.model);
            });
            if (state.compareMode && !state.compareTargets.length && state.imageProvider && state.imageModel) {
                state.compareTargets = [{ provider: state.imageProvider, model: state.imageModel }];
            }
        }
    }

    function activeImageTargetModels() {
        ensureValidModels();
        if (state.compareMode && state.compareTargets.length >= 2) {
            return state.compareTargets.slice(0, 4);
        }
        return [{ provider: state.imageProvider, model: state.imageModel }];
    }

    function shortModelLabel(modelId) {
        const msFound = MS_AGENT_IMAGE_MODELS.find(m => m.id === modelId);
        if (msFound) return msFound.name.replace(/\s*\(MS\)$/, '');
        return String(modelId || '模型').split('/').pop().split(':')[0];
    }

    function sizeSummaryLabel() {
        if (state.sizeMode === 'auto') return '自动尺寸';
        if (state.sizeMode === 'custom') return `${state.customW}×${state.customH}`;
        const ratioText = RATIO_KEY_TO_LABEL[state.ratioKey] || '1:1';
        return `${ratioText} · ${state.resTier.toUpperCase()}`;
    }

    /* ===== Node Resolution, Semantic Naming & Upstream Lineage Extraction ===== */
    function parseRefKey(refKey) {
        const raw = String(refKey || '').trim();
        const hashIdx = raw.indexOf('#');
        if (hashIdx > 0) {
            const nodeId = raw.slice(0, hashIdx);
            const subIdx = Number(raw.slice(hashIdx + 1));
            return { key: raw, nodeId, imageIndex: Number.isFinite(subIdx) ? subIdx : -1 };
        }
        return { key: raw, nodeId: raw, imageIndex: -1 };
    }

    function sortedAllCanvasNodes() {
        const list = (typeof nodes !== 'undefined' && Array.isArray(nodes)) ? nodes.filter(n => n && n.id !== '__smart_log_preview__') : [];
        return list.slice().sort((a, b) => {
            const ay = Number(a.y) || 0, by = Number(b.y) || 0;
            if (Math.abs(ay - by) > 90) return ay - by;
            return (Number(a.x) || 0) - (Number(b.x) || 0);
        });
    }

    function nodeKindDisplayLabel(node) {
        if (!node) return '节点';
        if (node.type === 'smart-prompt') return '提示词';
        if (node.type === 'smart-loop') return '循环';
        if (node.type === 'smart-minimax') return 'MiniMax';
        if (typeof isSmartGroupNode === 'function' && isSmartGroupNode(node)) return '分组';
        const imgCount = (node.images || []).length;
        if (imgCount > 1) return `多图(${imgCount})`;
        if (imgCount === 1) return (node.runAt || node.runPrompt) ? '生成图' : '原图';
        return '空白节点';
    }

    function nodeSemanticTitle(node, subImageIndex = -1) {
        const baseTitle = typeof smartSemanticNodeTitle === 'function'
            ? smartSemanticNodeTitle(node)
            : (node?.title || '节点');
        if (subImageIndex >= 0 && Array.isArray(node?.images) && node.images.length > 1) {
            const subImg = node.images[subImageIndex];
            const subName = String(subImg?.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
            if (subName && !/^(?:output|image|ai_ref|canvas_media)/i.test(subName)) {
                return subName.slice(0, 18);
            }
            return `${baseTitle}·图${subImageIndex + 1}`;
        }
        return baseTitle;
    }

    function nodeTextSummary(node) {
        if (!node) return '';
        if (node.type === 'smart-prompt') {
            return String((typeof textForNode === 'function' ? textForNode(node) : node.text) || '').trim();
        }
        if (node.type === 'smart-loop') {
            return String((typeof smartLoopPrompt === 'function' ? smartLoopPrompt(node) : node.variablePrompt) || '').trim();
        }
        if (typeof isSmartGroupNode === 'function' && isSmartGroupNode(node)) {
            return String((typeof textForNode === 'function' ? textForNode(node) : '') || '').trim();
        }
        return String(node.runPrompt || node.promptDraftText || '').trim();
    }

    function resolveRefItemDetails(refKey, fallbackOrder = 1) {
        const { key, nodeId, imageIndex } = parseRefKey(refKey);
        const node = (typeof nodes !== 'undefined' && Array.isArray(nodes)) ? nodes.find(n => n.id === nodeId) : null;
        if (!node) return null;

        const allImgs = (typeof imagesForNode === 'function' ? imagesForNode(node) : (node.images || []))
            .filter(item => item?.url);
        const targetImgs = (imageIndex >= 0 && node.images?.[imageIndex]?.url)
            ? [node.images[imageIndex]]
            : allImgs;

        const firstVisual = targetImgs.find(item => typeof isVideoMediaItem === 'function' ? !isVideoMediaItem(item) : true);
        const thumb = firstVisual?.url
            ? (typeof smartMediaPreviewUrl === 'function' ? smartMediaPreviewUrl(firstVisual, 256) : firstVisual.url)
            : '';

        const primaryUrl = firstVisual?.url
            ? ((typeof smartOriginalMediaUrl === 'function' ? smartOriginalMediaUrl(firstVisual) : firstVisual.url) || firstVisual.url)
            : (targetImgs[0]?.url || '');

        const imageUrls = targetImgs
            .filter(item => typeof isVideoMediaItem === 'function' ? !isVideoMediaItem(item) : true)
            .map(item => (typeof smartOriginalMediaUrl === 'function' ? smartOriginalMediaUrl(item) : item.url) || item.url)
            .filter(Boolean)
            .slice(0, 4);

        const videoUrls = targetImgs
            .filter(item => typeof isVideoMediaItem === 'function' && isVideoMediaItem(item))
            .map(item => item.url)
            .filter(Boolean)
            .slice(0, 1);

        const displayTitle = nodeSemanticTitle(node, imageIndex);
        const firstDim = targetImgs.find(item => Number(item.natural_w) > 0 && Number(item.natural_h) > 0);
        const textVal = nodeTextSummary(node);
        const isGenerated = Boolean(node.runAt || node.runPrompt || targetImgs.some(it => it.generatedResult));

        return {
            id: key,
            baseNodeId: node.id,
            subImageIndex: imageIndex,
            index: fallbackOrder,
            type: node.type || 'smart-image',
            kindLabel: nodeKindDisplayLabel(node),
            title: displayTitle,
            primaryUrl,
            primaryKind: firstVisual ? 'image' : (videoUrls.length ? 'video' : 'image'),
            image_urls: imageUrls,
            video_urls: videoUrls,
            text: textVal.slice(0, 1200),
            width: Number(firstDim?.natural_w || 0),
            height: Number(firstDim?.natural_h || 0),
            is_generated: isGenerated,
            is_upstream_origin: false,
            origin_for_id: '',
            thumb
        };
    }

    function buildAllMentionableEntries() {
        const sorted = sortedAllCanvasNodes();
        const entries = [];
        sorted.forEach((node, idx) => {
            const base = resolveRefItemDetails(node.id, idx + 1);
            if (base) {
                base.canvasNumber = idx + 1;
                entries.push(base);
            }
            if (Array.isArray(node.images) && node.images.length > 1) {
                node.images.forEach((img, subIdx) => {
                    if (!img?.url) return;
                    const sub = resolveRefItemDetails(`${node.id}#${subIdx}`, idx + 1);
                    if (sub) {
                        sub.canvasNumber = idx + 1;
                        sub.isSubItem = true;
                        entries.push(sub);
                    }
                });
            }
        });
        return entries;
    }

    /**
     * Optimization #2: Collects upstream original reference nodes for any referenced generated node
     * so multi-round iterative refinements never lose original product/scene source images!
     */
    function collectUpstreamOriginDetails(referencedItems, alreadyIncludedIds) {
        if (typeof inputNodesFor !== 'function' || typeof nodes === 'undefined') return [];
        const origins = [];
        const seen = new Set(alreadyIncludedIds);

        referencedItems.forEach(refItem => {
            const rootNode = nodes.find(n => n.id === refItem.baseNodeId);
            if (!rootNode) return;
            const queue = [{ node: rootNode, depth: 0 }];
            const visitedLocal = new Set([rootNode.id]);

            while (queue.length && origins.length < 6) {
                const { node: curr, depth } = queue.shift();
                if (depth >= 2) continue;
                const parents = inputNodesFor(curr) || [];
                parents.forEach(parent => {
                    if (!parent || visitedLocal.has(parent.id)) return;
                    visitedLocal.add(parent.id);
                    const detail = resolveRefItemDetails(parent.id, 0);
                    if (detail && (detail.image_urls.length || detail.text) && !seen.has(detail.id)) {
                        seen.add(detail.id);
                        origins.push({
                            ...detail,
                            selected: false,
                            mentioned: false,
                            is_upstream_origin: true,
                            origin_for_id: refItem.id
                        });
                    }
                    queue.push({ node: parent, depth: depth + 1 });
                });
            }
        });
        return origins;
    }

    /* ===== Optimization #3: Recipe Lineage Highlight on Canvas ===== */
    function syncLineageHighlight() {
        if (typeof world === 'undefined' || !world) return;
        const seeds = typeof selectedNodeIds === 'function' ? selectedNodeIds() : [];
        const conns = (typeof canvas !== 'undefined' && Array.isArray(canvas?.connections)) ? canvas.connections : [];

        const clearLineage = () => {
            world.classList.remove('sa-lineage-mode');
            world.querySelectorAll('.sa-lineage-node, .sa-lineage-source').forEach(el => {
                el.classList.remove('sa-lineage-node', 'sa-lineage-source');
            });
            world.querySelectorAll('.sa-lineage-edge').forEach(el => el.classList.remove('sa-lineage-edge'));
        };

        if (!seeds.length || !conns.length) {
            clearLineage();
            return;
        }

        const activeConns = conns.filter(c => (c.kind || 'flow') !== 'history');
        const lineageNodes = new Set(seeds);
        const upstreamSources = new Set();
        const lineagePairs = new Set();

        // Walk upstream recursively (full recipe ancestors)
        const upQueue = [...seeds];
        while (upQueue.length) {
            const curr = upQueue.shift();
            activeConns.forEach(c => {
                if (c.to === curr) {
                    lineagePairs.add(`${c.from}|${c.to}`);
                    if (!lineageNodes.has(c.from)) {
                        lineageNodes.add(c.from);
                        upstreamSources.add(c.from);
                        upQueue.push(c.from);
                    } else {
                        upstreamSources.add(c.from);
                    }
                }
            });
        }

        // Walk downstream 1-2 hops
        const downQueue = seeds.map(id => ({ id, depth: 0 }));
        const seenDown = new Set(seeds);
        while (downQueue.length) {
            const { id: curr, depth } = downQueue.shift();
            if (depth >= 2) continue;
            activeConns.forEach(c => {
                if (c.from === curr) {
                    lineagePairs.add(`${c.from}|${c.to}`);
                    lineageNodes.add(c.to);
                    if (!seenDown.has(c.to)) {
                        seenDown.add(c.to);
                        downQueue.push({ id: c.to, depth: depth + 1 });
                    }
                }
            });
        }

        if (lineageNodes.size <= seeds.length) {
            clearLineage();
            return;
        }

        // Also include parent smart-group containers of any lineage member
        if (typeof smartGroupScopeId === 'function') {
            [...lineageNodes].forEach(nid => {
                const scope = smartGroupScopeId(nid);
                if (scope) lineageNodes.add(scope);
            });
        }

        world.classList.add('sa-lineage-mode');
        world.querySelectorAll('.image-node[data-id]').forEach(el => {
            const id = el.dataset.id;
            el.classList.toggle('sa-lineage-node', lineageNodes.has(id));
            el.classList.toggle('sa-lineage-source', upstreamSources.has(id));
        });
        world.querySelectorAll('svg.connection-layer [data-geometry-from][data-geometry-to]').forEach(el => {
            const from = el.dataset.geometryFrom;
            const to = el.dataset.geometryTo;
            const onPath = lineagePairs.has(`${from}|${to}`) || (lineageNodes.has(from) && lineageNodes.has(to));
            el.classList.toggle('sa-lineage-edge', onPath);
        });
    }

    /* ===== Optimization #4: Starred Favorites & One-Click ZIP Export ===== */
    let crcTable = null;
    function crc32Bytes(bytes) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                crcTable[i] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function buildSimpleZipBlob(entries) {
        const encoder = new TextEncoder();
        const files = [];
        const central = [];
        let offset = 0;
        entries.forEach(entry => {
            const nameBytes = encoder.encode(entry.name);
            const data = entry.bytes;
            const crc = crc32Bytes(data);
            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nameBytes.length, true);
            local.set(nameBytes, 30);
            files.push(local, data);

            const cd = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(cd.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint32(42, offset, true);
            cd.set(nameBytes, 46);
            central.push(cd);
            offset += local.length + data.length;
        });
        const centralSize = central.reduce((s, b) => s + b.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);
        return new Blob([...files, ...central, end], { type: 'application/zip' });
    }

    async function downloadAllStarredNodesZip() {
        const starredNodes = sortedAllCanvasNodes().filter(n => n.starred);
        if (!starredNodes.length) {
            if (typeof toast === 'function') toast('还没有标记 ⭐ 定稿的节点');
            return;
        }
        if (typeof toast === 'function') toast(`正在打包 ${starredNodes.length} 个定稿节点原图…`);
        const entries = [];
        const usedNames = new Set();
        let idx = 1;
        for (const node of starredNodes) {
            const imgs = (typeof imagesForNode === 'function' ? imagesForNode(node) : (node.images || [])).filter(it => it?.url);
            const baseTitle = String(nodeSemanticTitle(node) || `定稿_${idx}`).replace(/[\\/:*?"<>|]+/g, '_').trim();
            for (let j = 0; j < imgs.length; j++) {
                const rawUrl = (typeof smartOriginalMediaUrl === 'function' ? smartOriginalMediaUrl(imgs[j]) : imgs[j].url) || imgs[j].url;
                const fetchUrl = /^https?:\/\//i.test(rawUrl)
                    ? `/api/download-output?url=${encodeURIComponent(rawUrl)}&inline=true`
                    : rawUrl;
                try {
                    const res = await fetch(fetchUrl);
                    if (!res.ok) continue;
                    const bytes = new Uint8Array(await res.arrayBuffer());
                    const extMatch = rawUrl.split('?')[0].match(/\.(png|jpg|jpeg|webp|mp4|gif)$/i);
                    const ext = extMatch ? extMatch[0].toLowerCase() : '.png';
                    let filename = imgs.length > 1
                        ? `${String(idx).padStart(2, '0')}_${baseTitle}_${j + 1}${ext}`
                        : `${String(idx).padStart(2, '0')}_${baseTitle}${ext}`;
                    let counter = 2;
                    while (usedNames.has(filename)) {
                        filename = `${String(idx).padStart(2, '0')}_${baseTitle}_${counter++}${ext}`;
                    }
                    usedNames.add(filename);
                    entries.push({ name: filename, bytes });
                } catch (_) {}
            }
            idx++;
        }
        if (!entries.length) {
            if (typeof toast === 'function') toast('定稿节点中没有可下载的图片文件');
            return;
        }
        const zipBlob = buildSimpleZipBlob(entries);
        const cvTitle = String((typeof canvas !== 'undefined' && canvas?.title) || '智能画布').replace(/[\\/:*?"<>|]+/g, '_');
        if (typeof downloadBlob === 'function') {
            downloadBlob(zipBlob, `${cvTitle}_定稿合集(${entries.length}张).zip`);
        }
        if (typeof toast === 'function') toast(`已打包下载 ${entries.length} 张定稿大图`);
    }

    function toggleNodeStarred(nodeId) {
        const node = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === nodeId);
        if (!node) return;
        node.starred = !node.starred;
        if (typeof render === 'function') render();
        if (typeof scheduleSave === 'function') scheduleSave();
        if (state.outlineOpen) renderOutlineList();
        if (typeof toast === 'function') toast(node.starred ? '⭐ 已标记为定稿' : '已取消定稿标记');
    }

    function startInlineNodeRename(nodeId, titleEl) {
        const node = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === nodeId);
        if (!node || !titleEl || titleEl.querySelector('input')) return;
        const current = nodeSemanticTitle(node);
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 60;
        input.value = current;
        input.className = 'sa-node-rename-input';
        titleEl.innerHTML = '';
        titleEl.appendChild(input);
        input.focus();
        input.select();
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('dblclick', e => e.stopPropagation());

        let finished = false;
        const commit = save => {
            if (finished) return;
            finished = true;
            const nextVal = input.value.trim();
            if (save && nextVal) {
                node.title = nextVal;
                node.customTitle = true;
                if (typeof scheduleSave === 'function') scheduleSave();
            }
            if (typeof render === 'function') render();
            if (state.outlineOpen) renderOutlineList();
        };
        input.addEventListener('blur', () => commit(true));
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(true); }
            if (e.key === 'Escape') { e.preventDefault(); commit(false); }
        });
    }

    /* ===== Inline Token Rich Input Operations ===== */
    function createAgentInlineTokenElement(detail) {
        const span = document.createElement('span');
        span.className = 'sa-inline-token';
        span.contentEditable = 'false';
        span.dataset.refKey = detail.id;
        span.dataset.nodeId = detail.baseNodeId;
        span.dataset.imageIndex = String(detail.subImageIndex ?? -1);
        span.dataset.name = detail.title;
        span.dataset.thumb = detail.thumb || '';
        span.innerHTML = `${detail.thumb ? `<img src="${escapeHtml(detail.thumb)}" alt="">` : ''}<span class="sa-inline-token-label">${escapeHtml(detail.title)}</span>`;
        span.onclick = e => {
            e.stopPropagation();
            focusCanvasNodeById(detail.baseNodeId, true);
        };
        return span;
    }

    function saveAgentCaretRange() {
        if (!els.richInput) return;
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const r = sel.getRangeAt(0);
        if (els.richInput.contains(r.commonAncestorContainer)) {
            state.savedCaretRange = r.cloneRange();
        }
    }

    function insertInlineTokenIntoAgentInput(refKey, options = {}) {
        if (!els.richInput) return;
        const detail = resolveRefItemDetails(refKey);
        if (!detail) return;

        const sel = window.getSelection();
        let range = null;

        if (options.replaceRange) {
            range = options.replaceRange.cloneRange();
            range.deleteContents();
        } else if (state.savedCaretRange && els.richInput.contains(state.savedCaretRange.commonAncestorContainer)) {
            range = state.savedCaretRange.cloneRange();
        } else {
            range = document.createRange();
            range.selectNodeContents(els.richInput);
            range.collapse(false);
        }

        // Prevent duplicate consecutive insertion when clicking the same canvas node twice
        if (!options.allowDuplicateAdjacent) {
            let prev = null;
            if (range.startContainer === els.richInput) {
                prev = els.richInput.childNodes[range.startOffset - 1] || null;
                if (prev?.nodeType === Node.TEXT_NODE && !prev.textContent.trim()) {
                    prev = els.richInput.childNodes[range.startOffset - 2] || null;
                }
            } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
                if (range.startOffset === 0) {
                    prev = range.startContainer.previousSibling;
                } else if (!range.startContainer.textContent.slice(0, range.startOffset).trim() && range.startContainer.textContent.length <= 2) {
                    prev = range.startContainer.previousSibling;
                }
            }
            if (prev?.classList?.contains?.('sa-inline-token') && prev.dataset.refKey === detail.id) {
                return;
            }
        }

        const tokenEl = createAgentInlineTokenElement(detail);
        range.insertNode(tokenEl);
        const spacer = document.createTextNode(' ');
        tokenEl.after(spacer);

        const afterRange = document.createRange();
        afterRange.setStartAfter(spacer);
        afterRange.collapse(true);
        state.savedCaretRange = afterRange.cloneRange();

        if (options.focusInput !== false) {
            els.richInput.focus();
            sel.removeAllRanges();
            sel.addRange(afterRange);
        }
        syncSendButtonState();
    }

    function extractRichInputPayload() {
        const segments = [];
        const refKeyOrder = [];
        const refDetailByKey = new Map();

        const walk = node => {
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent) segments.push({ type: 'text', text: node.textContent });
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.classList?.contains('sa-inline-token')) {
                const rk = node.dataset.refKey || node.dataset.nodeId || '';
                const detail = resolveRefItemDetails(rk, refKeyOrder.length + 1);
                const name = detail?.title || node.dataset.name || '节点';
                const thumb = detail?.thumb || node.dataset.thumb || '';
                const baseNodeId = detail?.baseNodeId || node.dataset.nodeId || rk;
                if (detail && !refDetailByKey.has(detail.id)) {
                    refKeyOrder.push(detail.id);
                    refDetailByKey.set(detail.id, { ...detail, index: refKeyOrder.length, selected: true, mentioned: true });
                }
                const orderNum = detail ? (refKeyOrder.indexOf(detail.id) + 1) : 1;
                segments.push({
                    type: 'token',
                    refKey: rk,
                    baseNodeId,
                    name,
                    thumb,
                    orderNum
                });
                return;
            }
            if (node.tagName === 'BR') {
                segments.push({ type: 'text', text: '\n' });
                return;
            }
            const isBlock = node !== els.richInput && ['DIV', 'P', 'LI'].includes(node.tagName);
            if (isBlock && segments.length && segments[segments.length - 1]?.text && !/\n$/.test(segments[segments.length - 1].text)) {
                segments.push({ type: 'text', text: '\n' });
            }
            node.childNodes.forEach(walk);
        };

        els.richInput?.childNodes.forEach(walk);

        let messageForLlm = '';
        let plainDisplay = '';
        segments.forEach(seg => {
            if (seg.type === 'text') {
                messageForLlm += seg.text;
                plainDisplay += seg.text;
            } else if (seg.type === 'token') {
                messageForLlm += ` @[图${seg.orderNum}：${seg.name} (node_id=${seg.refKey})] `;
                plainDisplay += `[${seg.name}]`;
            }
        });

        const referencedItems = refKeyOrder.map(k => refDetailByKey.get(k)).filter(Boolean);
        return {
            segments,
            referencedItems,
            messageForLlm: messageForLlm.replace(/[ \t]+\n/g, '\n').trim(),
            plainDisplay: plainDisplay.trim()
        };
    }

    function richInputHasContent() {
        if (!els.richInput) return false;
        if (els.richInput.querySelector('.sa-inline-token')) return true;
        return Boolean((els.richInput.textContent || '').trim());
    }

    function clearAgentRichInput() {
        if (!els.richInput) return;
        els.richInput.innerHTML = '';
        state.savedCaretRange = null;
        syncSendButtonState();
    }

    let lastCopiedAgentClip = null;

    async function writeTextToSystemClipboard(text) {
        const val = String(text || '');
        if (!val) return false;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(val);
                return true;
            }
        } catch (_) {}
        try {
            const ta = document.createElement('textarea');
            ta.value = val;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, val.length);
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }

    function flashCopyButtonSuccess(btnEl) {
        if (!btnEl) return;
        const origHtml = btnEl._origCopyHtml || btnEl.innerHTML;
        btnEl._origCopyHtml = origHtml;
        clearTimeout(btnEl._copyResetTimer);
        btnEl.classList.add('is-copied');
        const labelEl = btnEl.querySelector('.sa-act-label');
        if (labelEl) {
            btnEl.innerHTML = `<i data-lucide="check"></i><span class="sa-act-label">已复制</span>`;
        } else {
            btnEl.innerHTML = `<i data-lucide="check"></i>`;
        }
        if (window.lucide) lucide.createIcons({ nodes: [btnEl] });
        btnEl._copyResetTimer = setTimeout(() => {
            btnEl.classList.remove('is-copied');
            btnEl.innerHTML = origHtml;
            if (window.lucide) lucide.createIcons({ nodes: [btnEl] });
        }, 1500);
    }

    async function copyAgentContent(plainText, options = {}) {
        const clean = String(plainText || '').trim();
        if (!clean) {
            if (typeof toast === 'function') toast('暂无可复制内容');
            return;
        }
        if (Array.isArray(options.segments) && options.segments.length) {
            lastCopiedAgentClip = {
                plain: clean,
                segments: JSON.parse(JSON.stringify(options.segments))
            };
        }
        const ok = await writeTextToSystemClipboard(clean);
        if (ok) {
            flashCopyButtonSuccess(options.buttonEl);
            if (typeof toast === 'function') toast(options.toastText || '已复制到剪贴板');
        } else if (typeof toast === 'function') {
            toast('复制失败，请手动选择复制');
        }
    }

    function buildTokenElementFromSegment(seg) {
        const rk = seg?.refKey || seg?.baseNodeId || '';
        const liveDetail = rk ? resolveRefItemDetails(rk) : null;
        if (liveDetail) return createAgentInlineTokenElement(liveDetail);
        return createAgentInlineTokenElement({
            id: rk,
            baseNodeId: seg?.baseNodeId || rk,
            subImageIndex: -1,
            title: seg?.name || '节点',
            thumb: seg?.thumb || ''
        });
    }

    function insertSegmentsIntoRichInput(segments, replaceAll = false) {
        if (!els.richInput || !Array.isArray(segments) || !segments.length) return;
        if (replaceAll) {
            els.richInput.innerHTML = '';
            segments.forEach(seg => {
                if (seg.type === 'token') {
                    els.richInput.appendChild(buildTokenElementFromSegment(seg));
                } else if (seg.text) {
                    const parts = String(seg.text).split('\n');
                    parts.forEach((p, idx) => {
                        if (idx > 0) els.richInput.appendChild(document.createElement('br'));
                        if (p) els.richInput.appendChild(document.createTextNode(p));
                    });
                }
            });
            const endRange = document.createRange();
            endRange.selectNodeContents(els.richInput);
            endRange.collapse(false);
            state.savedCaretRange = endRange.cloneRange();
            els.richInput.focus();
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(endRange);
            }
            syncSendButtonState();
            return;
        }

        const sel = window.getSelection();
        let range = (sel && sel.rangeCount && els.richInput.contains(sel.getRangeAt(0).commonAncestorContainer))
            ? sel.getRangeAt(0)
            : state.savedCaretRange;
        if (!range || !els.richInput.contains(range.commonAncestorContainer)) {
            range = document.createRange();
            range.selectNodeContents(els.richInput);
            range.collapse(false);
        }
        range.deleteContents();
        const frag = document.createDocumentFragment();
        let lastNode = null;
        segments.forEach(seg => {
            if (seg.type === 'token') {
                lastNode = buildTokenElementFromSegment(seg);
                frag.appendChild(lastNode);
            } else if (seg.text) {
                lastNode = document.createTextNode(seg.text);
                frag.appendChild(lastNode);
            }
        });
        range.insertNode(frag);
        if (lastNode) {
            const after = document.createRange();
            after.setStartAfter(lastNode);
            after.collapse(true);
            state.savedCaretRange = after.cloneRange();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(after);
            }
        }
        syncSendButtonState();
    }

    function populateAgentInputFromMessage(msg) {
        if (!msg || !els.richInput) return;
        if (!state.open) setAgentOpen(true);
        if (Array.isArray(msg.segments) && msg.segments.length) {
            insertSegmentsIntoRichInput(msg.segments, true);
        } else {
            els.richInput.textContent = String(msg.content || '');
            els.richInput.focus();
            saveAgentCaretRange();
            syncSendButtonState();
        }
    }

    function serializeDomFragmentToSegments(rootNode) {
        const segments = [];
        let plain = '';
        const walk = n => {
            if (n.nodeType === Node.TEXT_NODE) {
                if (n.textContent) {
                    segments.push({ type: 'text', text: n.textContent });
                    plain += n.textContent;
                }
                return;
            }
            if (n.nodeType !== Node.ELEMENT_NODE) return;
            if (n.classList?.contains('sa-inline-token')) {
                const rk = n.dataset.refKey || n.dataset.locateNode || n.dataset.nodeId || '';
                const name = n.dataset.name || n.textContent?.trim() || '节点';
                const thumb = n.dataset.thumb || n.querySelector('img')?.getAttribute('src') || '';
                segments.push({
                    type: 'token',
                    refKey: rk,
                    baseNodeId: n.dataset.nodeId || n.dataset.locateNode || rk,
                    name,
                    thumb
                });
                plain += `[${name}]`;
                return;
            }
            if (n.tagName === 'BR') {
                segments.push({ type: 'text', text: '\n' });
                plain += '\n';
                return;
            }
            n.childNodes.forEach(walk);
        };
        rootNode.childNodes.forEach(walk);
        return { segments, plain: plain.trim() };
    }

    /* ===== Generated Node Native Composer Inline Token Builder ===== */
    function buildGeneratedNodeComposerTokens(promptText, sourceDetails) {
        const raw = String(promptText || '').trim();
        const validSources = (sourceDetails || []).filter(d => d && d.primaryUrl);
        if (!raw || !validSources.length || typeof mentionTokenHtml !== 'function') {
            return {
                html: escapeHtml(raw),
                plainText: raw,
                promptRefs: []
            };
        }

        const promptRefs = validSources.map((d, idx) => ({
            url: d.primaryUrl,
            name: `图片 ${idx + 1}`,
            kind: d.primaryKind || 'image',
            nodeId: d.baseNodeId,
            imageIndex: d.subImageIndex >= 0 ? d.subImageIndex : 0
        }));

        // Match 图片 1 / 图片1 / 图 1 / 图1 / @[图1...]
        const pattern = /@?\[?\s*(?:图片|图)\s*([1-9]\d?)(?:[：:][^\]\s]+)?\s*\]?/g;
        let lastIdx = 0;
        let html = '';
        let plainWithAt = '';
        let matchedAny = false;
        let match;

        while ((match = pattern.exec(raw)) !== null) {
            const num = Number(match[1]);
            const ref = promptRefs[num - 1];
            html += escapeHtml(raw.slice(lastIdx, match.index));
            plainWithAt += raw.slice(lastIdx, match.index);
            if (ref) {
                matchedAny = true;
                html += mentionTokenHtml(ref);
                plainWithAt += `@${ref.name}`;
            } else {
                html += escapeHtml(match[0]);
                plainWithAt += match[0];
            }
            lastIdx = match.index + match[0].length;
        }
        html += escapeHtml(raw.slice(lastIdx));
        plainWithAt += raw.slice(lastIdx);

        // If the LLM didn't write literal "图1/图片 1" in the prompt, prepend inline reference pills cleanly
        if (!matchedAny && promptRefs.length) {
            const prefixHtml = promptRefs.map(ref => mentionTokenHtml(ref)).join(' ') + ' ';
            const prefixPlain = promptRefs.map(ref => `@${ref.name}`).join(' ') + ' ';
            html = prefixHtml + escapeHtml(raw);
            plainWithAt = prefixPlain + raw;
        }

        return {
            html,
            plainText: plainWithAt,
            promptRefs
        };
    }

    /* ===== Direct Canvas Node Click -> Inline Token Insertion + Star/Rename Delegation ===== */
    function bindCanvasInteractions() {
        if (typeof world === 'undefined' || !world || world._saInteractionsBound) return;
        world._saInteractionsBound = true;

        // Delegate Star button & Double-Click Title Rename on canvas
        world.addEventListener('mousedown', e => {
            if (e.target.closest('[data-star-node]')) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        world.addEventListener('click', e => {
            const starBtn = e.target.closest('[data-star-node]');
            if (starBtn) {
                e.preventDefault();
                e.stopPropagation();
                toggleNodeStarred(starBtn.dataset.starNode);
            }
        }, true);

        world.addEventListener('dblclick', e => {
            const titleEl = e.target.closest('[data-rename-node]');
            if (titleEl) {
                e.preventDefault();
                e.stopPropagation();
                startInlineNodeRename(titleEl.dataset.renameNode, titleEl);
            }
        }, true);

        // Direct Click on Canvas Node -> Insert Inline Token at Caret in Agent Input
        let clickTracker = null;
        world.addEventListener('mousedown', e => {
            clickTracker = null;
            if (!state.open || !state.clickToRef) return;
            if (e.button !== 0 || e.detail >= 2) return;
            if (typeof isSpaceKeyDown !== 'undefined' && isSpaceKeyDown) return;
            if (e.ctrlKey || e.metaKey) return;
            // Ignore clicks inside the node's own bottom composer or action buttons
            if (e.target.closest('.composer, [data-star-node], .sa-node-rename-input, .node-delete, .image-delete, .mini-x, .node-port, .node-resize-handle, .node-drop, [data-smart-node-action], [data-smart-group-action], [data-jimeng-query], [data-image-task-query], .smart-video-play, input, textarea, select, button, [contenteditable="true"]')) {
                return;
            }
            const nodeEl = e.target.closest('.image-node[data-id]');
            if (!nodeEl) return;

            const topNodeId = nodeEl.dataset.id;
            let resolvedKey = topNodeId;
            const thumbEl = e.target.closest('.thumb-item, .image-wrap');
            if (thumbEl) {
                const refMemberId = thumbEl.dataset.refNodeId || '';
                const refImgIdx = thumbEl.dataset.refImageIndex;
                if (refMemberId) {
                    const memberNode = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === refMemberId);
                    if (memberNode && (memberNode.images || []).length > 1 && refImgIdx !== undefined) {
                        resolvedKey = `${refMemberId}#${Number(refImgIdx)}`;
                    } else {
                        resolvedKey = refMemberId;
                    }
                } else {
                    const ownerNode = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === topNodeId);
                    const subIdx = Number(thumbEl.dataset.imageIndex);
                    if (ownerNode && (ownerNode.images || []).length > 1 && Number.isFinite(subIdx)) {
                        resolvedKey = `${topNodeId}#${subIdx}`;
                    }
                }
            }

            clickTracker = {
                refKey: resolvedKey,
                startX: e.clientX,
                startY: e.clientY,
                moved: false,
                startedAt: Date.now()
            };
        }, true);

        window.addEventListener('mousemove', e => {
            if (!clickTracker) return;
            if (Math.hypot(e.clientX - clickTracker.startX, e.clientY - clickTracker.startY) > 6) {
                clickTracker.moved = true;
            }
        }, true);

        window.addEventListener('mouseup', e => {
            if (!clickTracker) return;
            const tracked = clickTracker;
            clickTracker = null;
            if (tracked.moved || Date.now() - tracked.startedAt > 900) return;
            if (!state.open || !state.clickToRef || e.detail >= 2) return;

            // Insert inline [🖼 节点名] token directly at saved cursor in Agent input,
            // without disturbing Smart Canvas's native selection & composer!
            insertInlineTokenIntoAgentInput(tracked.refKey, { focusInput: false, allowDuplicateAdjacent: false });
        }, true);
    }

    /* ===== Build DOM (Left Outline Panel + Floating Orb + Right/Floating Agent Panel + Body Popover Portal) ===== */
    function mountAgentUI() {
        if (document.getElementById('smartAgentPanel')) return;

        // 1. Left-side Node Outline Toggle & Panel (Cmd+F)
        const outlineBtn = document.createElement('button');
        outlineBtn.id = 'saOutlineToggleBtn';
        outlineBtn.type = 'button';
        outlineBtn.className = 'sa-outline-toggle';
        outlineBtn.title = '节点列表与全局搜索 (Ctrl/Cmd + F)';
        outlineBtn.innerHTML = `<i data-lucide="layers"></i><span>节点列表</span><span class="sa-outline-count" id="saOutlineCount">0</span>`;

        const outlinePanel = document.createElement('aside');
        outlinePanel.id = 'saOutlinePanel';
        outlinePanel.className = 'sa-outline-panel';
        outlinePanel.innerHTML = `
            <div class="sa-outline-head">
                <div class="sa-outline-head-title"><i data-lucide="layers"></i><span>节点列表与搜索</span></div>
                <button type="button" class="sa-icon-btn" id="saOutlineCloseBtn"><i data-lucide="x"></i></button>
            </div>
            <div class="sa-outline-search-box">
                <i data-lucide="search"></i>
                <input type="search" class="sa-outline-search-input" id="saOutlineSearch" placeholder="搜索节点标题、生图提示词、文件名…">
            </div>
            <div class="sa-outline-tabs" id="saOutlineTabs">
                <button type="button" class="sa-outline-tab active" data-otab="all">全部</button>
                <button type="button" class="sa-outline-tab" data-otab="starred">⭐ 定稿</button>
                <button type="button" class="sa-outline-tab" data-otab="generated">生图结果</button>
                <button type="button" class="sa-outline-tab" data-otab="source">原图素材</button>
                <button type="button" class="sa-outline-tab" data-otab="other">分组/文本</button>
            </div>
            <div class="sa-outline-bar" id="saStarExportBar">
                <span id="saStarExportText">已收藏 0 个定稿节点</span>
                <button type="button" class="sa-mini-btn primary" id="saDownloadStarredBtn">打包下载定稿</button>
            </div>
            <div class="sa-outline-list" id="saOutlineList"></div>
        `;

        // 2. Floating Minimized Orb
        const orbWrap = document.createElement('div');
        orbWrap.id = 'smartAgentOrb';
        orbWrap.className = 'sa-orb-wrap';
        orbWrap.innerHTML = `
            <div class="sa-orb-tip">创作 Agent</div>
            <button type="button" class="sa-orb-btn" id="saOrbBtn" title="打开创作 Agent" aria-label="打开创作 Agent"></button>
        `;

        // 3. Magnetic Right-Edge Dock Snap Preview Overlay
        const dockSnapZone = document.createElement('div');
        dockSnapZone.id = 'saDockSnapZone';
        dockSnapZone.className = 'sa-dock-snap-zone';
        dockSnapZone.setAttribute('aria-hidden', 'true');
        dockSnapZone.innerHTML = `
            <div class="sa-dock-snap-badge">
                <i data-lucide="panel-right"></i>
                <span>松开以停靠到右侧</span>
            </div>
        `;

        // 4. LibTV-style Agent Panel (Docked Right Sidebar <-> Floating Card)
        const panel = document.createElement('aside');
        panel.id = 'smartAgentPanel';
        panel.className = 'sa-panel is-docked';
        panel.innerHTML = `
            <div class="sa-dock-resize-handle" id="saDockResizeHandle" title="拖拽调整右侧停靠宽度"></div>
            <div class="sa-float-resize-handle" id="saFloatResizeHandle" title="拖拽调整浮窗尺寸"></div>
            <header class="sa-header" id="saHeader">
                <button type="button" class="sa-thread-btn" id="saThreadBtn" title="切换对话记录">
                    <span class="sa-thread-title" id="saThreadTitle">新对话</span>
                    <i data-lucide="chevron-down"></i>
                </button>
                <div class="sa-head-actions">
                    <button type="button" class="sa-icon-btn" id="saNewChatBtn" data-tip="新建对话" aria-label="新建对话">
                        <i data-lucide="plus-circle"></i>
                    </button>
                    <button type="button" class="sa-icon-btn" id="saClickRefToggleBtn" data-tip="点选画布自动引用" aria-label="点选画布自动引用">
                        <i data-lucide="mouse-pointer-click"></i>
                    </button>
                    <button type="button" class="sa-icon-btn" id="saSysBtn" data-tip="系统提示词与设置" aria-label="系统提示词与设置">
                        <i data-lucide="sliders-horizontal"></i>
                        <span class="sa-icon-dot"></span>
                    </button>
                    <button type="button" class="sa-icon-btn" id="saFocusCanvasBtn" data-tip="适配画布视图" aria-label="适配画布视图">
                        <i data-lucide="scan-eye"></i>
                    </button>
                    <button type="button" class="sa-icon-btn" id="saDockToggleBtn" data-tip="切换为浮窗" data-tip-align="right" aria-label="切换为浮窗">
                        <i data-lucide="picture-in-picture-2"></i>
                    </button>
                    <button type="button" class="sa-icon-btn" id="saMinimizeBtn" data-tip="收起为悬浮球" data-tip-align="right" aria-label="收起为悬浮球">
                        <i data-lucide="minus"></i>
                    </button>
                </div>
            </header>

            <!-- History Drawer -->
            <div class="sa-drawer" id="saHistoryDrawer">
                <div class="sa-drawer-head">
                    <span>对话记录</span>
                    <button type="button" class="sa-icon-btn" id="saHistoryClose"><i data-lucide="x"></i></button>
                </div>
                <div class="sa-drawer-body">
                    <div class="sa-thread-list" id="saThreadList"></div>
                </div>
            </div>

            <!-- System Prompt & Skills Drawer -->
            <div class="sa-drawer" id="saSysDrawer">
                <div class="sa-drawer-head">
                    <span>Agent 系统提示词与 Skills</span>
                    <button type="button" class="sa-icon-btn" id="saSysClose"><i data-lucide="x"></i></button>
                </div>
                <div class="sa-drawer-body">
                    <div class="sa-sys-source-row">
                        <span class="sa-sys-badge" id="saSysSourceBadge">已同步：Agent智能改图</span>
                        <div style="display:flex;gap:6px;">
                            <button type="button" class="sa-mini-btn" id="saSyncFromGptBtn">同步智能改图</button>
                            <button type="button" class="sa-mini-btn" id="saSkillManageBtn">管理 Skills</button>
                        </div>
                    </div>
                    <div class="sa-sys-preset-section" hidden>
                        <div class="sa-sys-preset-label">预设系统提示词</div>
                        <div class="sa-preset-strip" id="saPresetStrip"></div>
                    </div>
                    <textarea class="sa-sys-textarea" id="saSysTextarea" placeholder="带入 Agent智能改图 的系统提示词，或在此微调…"></textarea>
                    <div class="sa-skill-row">
                        <select id="saSkillSelect" class="sa-skill-select" multiple size="3" aria-label="选择 Skills"></select>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:8px;">
                        <button type="button" class="sa-mini-btn" id="saSysClearBtn">清空</button>
                        <div style="display:flex;gap:6px;">
                            <button type="button" class="sa-mini-btn" id="saSysSaveToGptBtn">保存并同步到智能改图</button>
                            <button type="button" class="sa-mini-btn primary" id="saSysSaveBtn">应用到画布</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Messages Stream -->
            <div class="sa-body" id="saMessages"></div>

            <!-- Rich Inline-Token Input Composer -->
            <div class="sa-composer-wrap">
                <div class="sa-composer" id="saComposerBox">
                    <div id="saRichInput" class="sa-rich-input" contenteditable="true" spellcheck="false" data-placeholder="开始你的创作，直接点击画布节点或输入 @ 插入节点引用…"></div>
                    <input id="saUploadInput" type="file" accept="image/*,video/*" multiple hidden>
                    <div class="sa-toolbar">
                        <div class="sa-tools-left">
                            <button type="button" class="sa-tool-btn icon-only" id="saUploadBtn" title="上传参考图或引用画布节点">
                                <i data-lucide="plus"></i>
                            </button>
                            <button type="button" class="sa-tool-btn" id="saModelBtn" title="选择对话大脑与生图模型（支持多模型并排对比）">
                                <i data-lucide="box"></i>
                                <span class="sa-tool-label" id="saModelBtnLabel">模型</span>
                            </button>
                            <button type="button" class="sa-tool-btn" id="saSkillBtn" title="Skill 与提示词预设" aria-label="Skill 与提示词预设">
                                <i data-lucide="book-marked"></i>
                                <span class="sa-tool-badge" id="saSkillBadgeCount"></span>
                            </button>
                            <button type="button" class="sa-tool-btn" id="saSizeBtn" title="选择生图比例与分辨率尺寸">
                                <i data-lucide="proportions"></i>
                                <span class="sa-tool-label" id="saSizeBtnLabel">自动尺寸</span>
                            </button>
                            <button type="button" class="sa-tool-btn active" id="saAutoRunBtn" title="切换手动生成 / 自动生成模式">
                                <span class="sa-mode-btn-icon" id="saAutoRunIconWrap"><i data-lucide="refresh-cw"></i></span>
                                <span class="sa-tool-label" id="saAutoRunLabel">自动生成</span>
                            </button>
                        </div>
                        <button type="button" class="sa-send-btn" id="saSendBtn" title="发送">
                            <i data-lucide="arrow-up"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // 5. Body-Level Fixed Popover Portal (Zero Clipping — LibTV Exact Style)
        const popoverPortal = document.createElement('div');
        popoverPortal.id = 'saPopoverPortal';
        popoverPortal.className = 'sa-popover-portal';
        popoverPortal.innerHTML = `
            <!-- Popover 1: + Attachment / Mention Menu -->
            <div class="sa-popover sa-attach-popover" id="saAttachPopover">
                <button type="button" class="sa-menu-row-btn" id="saAttachLocalBtn">
                    <i data-lucide="image-plus"></i><span>本地上传图片 / 视频</span>
                </button>
                <button type="button" class="sa-menu-row-btn" id="saAttachMentionBtn">
                    <i data-lucide="at-sign"></i><span>引用画布节点 (@)</span>
                </button>
            </div>

            <!-- Popover 2: Model Picker (LibTV Card List + Multi-Model Compare) -->
            <div class="sa-popover sa-model-popover" id="saModelPopover">
                <div class="sa-pop-title-lg">
                    <span>选择模型</span>
                    <button type="button" class="sa-compare-toggle" id="saCompareToggleBtn">多模型对比</button>
                </div>
                <div class="sa-scope-tabs-full">
                    <button type="button" id="saScopeImageBtn" class="active">生图模型</button>
                    <button type="button" id="saScopeChatBtn">对话大脑</button>
                </div>
                <div class="sa-provider-pills" id="saProviderList"></div>
                <div class="sa-compare-bar" id="saCompareBar">
                    <span>勾选多个模型可并排建节点同时对比出图</span>
                </div>
                <div class="sa-model-cards-list" id="saModelList"></div>
            </div>

            <!-- Popover 3: Skill & Prompt Presets (LibTV Screenshot 3) -->
            <div class="sa-popover sa-skill-popover" id="saSkillPopover">
                <div class="sa-skill-pop-head">
                    <div class="sa-skill-pop-title">Skill</div>
                    <div class="sa-skill-pop-actions">
                        <button type="button" class="sa-skill-head-btn" id="saSkillCreateBtn">
                            <i data-lucide="plus"></i><span>创建</span>
                        </button>
                        <button type="button" class="sa-skill-head-btn" id="saSkillSysBtn">
                            <span>系统词</span>
                        </button>
                    </div>
                </div>
                <div class="sa-skill-filter-bar">
                    <div class="sa-skill-tabs" id="saSkillFilterTabs">
                        <button type="button" class="sa-skill-tab-btn active" data-stab="all">全部</button>
                        <button type="button" class="sa-skill-tab-btn" data-stab="skills">Skills</button>
                        <button type="button" class="sa-skill-tab-btn" data-stab="presets">预设词</button>
                        <button type="button" class="sa-skill-tab-btn" data-stab="active">已启用</button>
                    </div>
                    <div class="sa-skill-search-wrap">
                        <i data-lucide="search"></i>
                        <input id="saSkillSearchInput" class="sa-skill-search-input" type="search" placeholder="搜索 Skill">
                    </div>
                </div>
                <div class="sa-skill-items-list" id="saSkillItemsList"></div>
            </div>

            <!-- Popover 4: Execution Mode Menu (手动生成 / 自动生成 — LibTV Screenshot 4) -->
            <div class="sa-popover sa-mode-popover" id="saModePopover">
                <button type="button" class="sa-mode-option-btn" id="saModeOptManual" data-auto-mode="manual">
                    <i class="sa-mode-opt-icon" data-lucide="hand"></i>
                    <div>
                        <div class="sa-mode-opt-title">手动生成</div>
                        <div class="sa-mode-opt-desc">仅在画布创建并连线生图节点，确认后再运行</div>
                    </div>
                    <i class="sa-mode-opt-check" data-lucide="check"></i>
                </button>
                <button type="button" class="sa-mode-option-btn" id="saModeOptAuto" data-auto-mode="auto">
                    <i class="sa-mode-opt-icon" data-lucide="refresh-cw"></i>
                    <div>
                        <div class="sa-mode-opt-title">自动生成</div>
                        <div class="sa-mode-opt-desc">创建生图节点后自动提交并开始出图</div>
                    </div>
                    <i class="sa-mode-opt-check" data-lucide="check"></i>
                </button>
            </div>

            <!-- Popover 5: Resolution & Aspect Ratio -->
            <div class="sa-popover" id="saSizePopover">
                <div class="sa-pop-head">
                    <span>比例与分辨率尺寸</span>
                    <div class="sa-scope-tabs">
                        <button type="button" data-size-mode="auto" class="active">自动</button>
                        <button type="button" data-size-mode="preset">内置尺寸</button>
                        <button type="button" data-size-mode="custom">自定义</button>
                    </div>
                </div>
                <div class="sa-size-body" id="saSizeBody"></div>
            </div>

            <!-- Popover 6: @Mention All-Node Picker -->
            <div class="sa-popover" id="saMentionPopover">
                <div class="sa-pop-head">
                    <span id="saMentionHeadTitle">引用画布节点</span>
                    <button type="button" class="sa-icon-btn" id="saMentionCloseBtn" style="width:22px;height:22px;"><i data-lucide="x"></i></button>
                </div>
                <div class="sa-mention-search-wrap">
                    <input type="search" class="sa-mention-search" id="saMentionSearch" placeholder="搜索节点名称、提示词或序号…">
                </div>
                <div class="sa-mention-scroll" id="saMentionList"></div>
            </div>
        `;

        document.body.appendChild(outlineBtn);
        document.body.appendChild(outlinePanel);
        document.body.appendChild(orbWrap);
        document.body.appendChild(dockSnapZone);
        document.body.appendChild(panel);
        document.body.appendChild(popoverPortal);

        els = {
            outlineBtn,
            outlineCount: document.getElementById('saOutlineCount'),
            outlinePanel,
            outlineCloseBtn: document.getElementById('saOutlineCloseBtn'),
            outlineSearch: document.getElementById('saOutlineSearch'),
            outlineTabs: document.getElementById('saOutlineTabs'),
            starExportBar: document.getElementById('saStarExportBar'),
            starExportText: document.getElementById('saStarExportText'),
            downloadStarredBtn: document.getElementById('saDownloadStarredBtn'),
            outlineList: document.getElementById('saOutlineList'),
            orbWrap,
            orbBtn: document.getElementById('saOrbBtn'),
            dockSnapZone,
            panel,
            dockResizeHandle: document.getElementById('saDockResizeHandle'),
            floatResizeHandle: document.getElementById('saFloatResizeHandle'),
            header: document.getElementById('saHeader'),
            threadBtn: document.getElementById('saThreadBtn'),
            threadTitle: document.getElementById('saThreadTitle'),
            newChatBtn: document.getElementById('saNewChatBtn'),
            clickRefToggleBtn: document.getElementById('saClickRefToggleBtn'),
            sysBtn: document.getElementById('saSysBtn'),
            focusCanvasBtn: document.getElementById('saFocusCanvasBtn'),
            dockToggleBtn: document.getElementById('saDockToggleBtn'),
            minimizeBtn: document.getElementById('saMinimizeBtn'),
            historyDrawer: document.getElementById('saHistoryDrawer'),
            historyClose: document.getElementById('saHistoryClose'),
            threadList: document.getElementById('saThreadList'),
            sysDrawer: document.getElementById('saSysDrawer'),
            sysClose: document.getElementById('saSysClose'),
            sysSourceBadge: document.getElementById('saSysSourceBadge'),
            syncFromGptBtn: document.getElementById('saSyncFromGptBtn'),
            skillManageBtn: document.getElementById('saSkillManageBtn'),
            sysTextarea: document.getElementById('saSysTextarea'),
            skillSelect: document.getElementById('saSkillSelect'),
            sysClearBtn: document.getElementById('saSysClearBtn'),
            sysSaveToGptBtn: document.getElementById('saSysSaveToGptBtn'),
            sysSaveBtn: document.getElementById('saSysSaveBtn'),
            messages: document.getElementById('saMessages'),
            presetStrip: document.getElementById('saPresetStrip'),
            popoverPortal,
            attachPopover: document.getElementById('saAttachPopover'),
            attachLocalBtn: document.getElementById('saAttachLocalBtn'),
            attachMentionBtn: document.getElementById('saAttachMentionBtn'),
            mentionPopover: document.getElementById('saMentionPopover'),
            mentionHeadTitle: document.getElementById('saMentionHeadTitle'),
            mentionCloseBtn: document.getElementById('saMentionCloseBtn'),
            mentionSearch: document.getElementById('saMentionSearch'),
            mentionList: document.getElementById('saMentionList'),
            modelPopover: document.getElementById('saModelPopover'),
            scopeImageBtn: document.getElementById('saScopeImageBtn'),
            scopeChatBtn: document.getElementById('saScopeChatBtn'),
            compareBar: document.getElementById('saCompareBar'),
            compareToggleBtn: document.getElementById('saCompareToggleBtn'),
            providerList: document.getElementById('saProviderList'),
            modelList: document.getElementById('saModelList'),
            skillPopover: document.getElementById('saSkillPopover'),
            skillCreateBtn: document.getElementById('saSkillCreateBtn'),
            skillSysBtn: document.getElementById('saSkillSysBtn'),
            skillFilterTabs: document.getElementById('saSkillFilterTabs'),
            skillSearchInput: document.getElementById('saSkillSearchInput'),
            skillItemsList: document.getElementById('saSkillItemsList'),
            modePopover: document.getElementById('saModePopover'),
            modeOptManual: document.getElementById('saModeOptManual'),
            modeOptAuto: document.getElementById('saModeOptAuto'),
            sizePopover: document.getElementById('saSizePopover'),
            sizeBody: document.getElementById('saSizeBody'),
            composerBox: document.getElementById('saComposerBox'),
            richInput: document.getElementById('saRichInput'),
            uploadInput: document.getElementById('saUploadInput'),
            uploadBtn: document.getElementById('saUploadBtn'),
            modelBtn: document.getElementById('saModelBtn'),
            modelBtnLabel: document.getElementById('saModelBtnLabel'),
            skillBtn: document.getElementById('saSkillBtn'),
            skillBadgeCount: document.getElementById('saSkillBadgeCount'),
            sizeBtn: document.getElementById('saSizeBtn'),
            sizeBtnLabel: document.getElementById('saSizeBtnLabel'),
            autoRunBtn: document.getElementById('saAutoRunBtn'),
            autoRunIconWrap: document.getElementById('saAutoRunIconWrap'),
            autoRunLabel: document.getElementById('saAutoRunLabel'),
            sendBtn: document.getElementById('saSendBtn')
        };

        [outlineBtn, outlinePanel, orbWrap, panel, popoverPortal].forEach(root => {
            root.addEventListener('mousedown', e => e.stopPropagation());
            root.addEventListener('pointerdown', e => e.stopPropagation());
            root.addEventListener('dblclick', e => e.stopPropagation());
            root.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
        });

        panel.addEventListener('copy', e => {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return;
            const range = sel.getRangeAt(0);
            if (!panel.contains(range.commonAncestorContainer)) return;
            const cloned = range.cloneContents();
            if (!cloned.querySelector?.('.sa-inline-token')) return;
            const { segments, plain } = serializeDomFragmentToSegments(cloned);
            if (!plain) return;
            e.preventDefault();
            e.clipboardData?.setData('text/plain', plain);
            e.clipboardData?.setData('application/x-sa-segments', JSON.stringify(segments));
            lastCopiedAgentClip = { plain, segments };
        });

        panel.addEventListener('paste', e => {
            const files = [...(e.clipboardData?.files || [])].filter(f => /^(image|video)\//i.test(f.type));
            if (files.length) {
                e.preventDefault();
                e.stopPropagation();
                uploadFilesIntoCanvasAndAgent(files);
                return;
            }
            // Rich segment or plain-text paste inside contenteditable richInput
            if (e.target.closest('#saRichInput')) {
                e.preventDefault();
                e.stopPropagation();
                const customSegJson = e.clipboardData?.getData('application/x-sa-segments') || '';
                const plain = e.clipboardData?.getData('text/plain') || '';
                if (customSegJson) {
                    try {
                        const parsed = JSON.parse(customSegJson);
                        if (Array.isArray(parsed) && parsed.length) {
                            insertSegmentsIntoRichInput(parsed, false);
                            return;
                        }
                    } catch (_) {}
                }
                if (plain && lastCopiedAgentClip && lastCopiedAgentClip.plain === plain.trim() && Array.isArray(lastCopiedAgentClip.segments)) {
                    insertSegmentsIntoRichInput(lastCopiedAgentClip.segments, false);
                    return;
                }
                if (plain) document.execCommand('insertText', false, plain);
            } else {
                e.stopPropagation();
            }
        });

        // Bind copy button inside Smart Canvas's own bottom #composer
        const composerCopyBtn = document.getElementById('promptCopyBtn');
        if (composerCopyBtn && !composerCopyBtn._saBound) {
            composerCopyBtn._saBound = true;
            composerCopyBtn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const txt = (typeof promptPlainText === 'function'
                    ? promptPlainText()
                    : (document.getElementById('promptInput')?.innerText || '')).trim();
                copyAgentContent(txt, { buttonEl: composerCopyBtn, toastText: '已复制节点提示词' });
            });
        }

        applySavedPositions();
        bindAgentEvents();
        bindCanvasInteractions();
        syncPanelOpenState();
        refreshAllAgentUI();
    }

    function applySavedPositions() {
        if (state.orbPos && Number.isFinite(state.orbPos.left) && Number.isFinite(state.orbPos.top)) {
            const left = Math.max(12, Math.min(window.innerWidth - 68, state.orbPos.left));
            const top = Math.max(12, Math.min(window.innerHeight - 68, state.orbPos.top));
            els.orbWrap.style.left = `${left}px`;
            els.orbWrap.style.top = `${top}px`;
            els.orbWrap.style.right = 'auto';
            els.orbWrap.style.bottom = 'auto';
        }
        syncPanelLayoutUi(false);
    }

    function syncPanelLayoutUi(animate = false) {
        if (!els.panel) return;
        const dockW = clampAgentDockWidth(state.dockWidth);
        state.dockWidth = dockW;
        document.documentElement.style.setProperty('--sa-dock-width', `${dockW}px`);

        const isDocked = state.layoutMode !== 'floating';
        if (animate) {
            els.panel.classList.add('is-morphing');
            clearTimeout(els.panel._morphTimer);
            els.panel._morphTimer = setTimeout(() => els.panel?.classList.remove('is-morphing'), 260);
        }

        els.panel.classList.toggle('is-docked', isDocked);
        els.panel.classList.toggle('is-floating', !isDocked);
        document.body.classList.toggle('sa-panel-docked-open', Boolean(state.open && isDocked && window.innerWidth > 720));

        if (isDocked) {
            els.panel.style.left = '';
            els.panel.style.top = '';
            els.panel.style.width = '';
            els.panel.style.height = '';
            els.panel.style.right = '';
            els.panel.style.bottom = '';
        } else {
            const r = normalizeAgentFloatRect(state.floatRect);
            state.floatRect = r;
            els.panel.style.left = `${r.left}px`;
            els.panel.style.top = `${r.top}px`;
            els.panel.style.width = `${r.width}px`;
            els.panel.style.height = `${r.height}px`;
            els.panel.style.right = 'auto';
            els.panel.style.bottom = 'auto';
        }

        if (els.dockToggleBtn) {
            const nextTip = isDocked ? '切换为浮窗' : '停靠到右侧';
            const nextIcon = isDocked ? 'picture-in-picture-2' : 'panel-right';
            els.dockToggleBtn.setAttribute('data-tip', nextTip);
            els.dockToggleBtn.setAttribute('aria-label', nextTip);
            els.dockToggleBtn.innerHTML = `<i data-lucide="${nextIcon}"></i>`;
            if (window.lucide) lucide.createIcons({ nodes: [els.dockToggleBtn] });
        }
    }

    function setPanelLayoutMode(nextMode, options = {}) {
        const target = nextMode === 'floating' ? 'floating' : 'docked';
        const prev = state.layoutMode;
        closeAllAgentPopovers();
        if (target === 'floating' && !state.floatRect) {
            state.floatRect = normalizeAgentFloatRect(null);
        }
        state.layoutMode = target;
        syncPanelLayoutUi(options.animate !== false && prev !== target);
        saveAgentSettings();
        if (options.toast !== false && prev !== target && typeof toast === 'function') {
            toast(target === 'docked' ? '已停靠到画布右侧' : '已切换为可拖拽浮窗卡片');
        }
    }

    function syncPanelOpenState() {
        els.panel.classList.toggle('open', state.open);
        els.orbWrap.classList.toggle('is-hidden', state.open);
        els.clickRefToggleBtn?.classList.toggle('active', state.clickToRef);
        syncPanelLayoutUi(false);
        if (state.open) {
            renderPresetStrip();
            updateToolbarLabels();
        }
        if (window.lucide) lucide.createIcons();
    }

    function setAgentOpen(open) {
        state.open = Boolean(open);
        closeAllAgentPopovers();
        syncPanelOpenState();
        saveAgentSettings();
        if (state.open) {
            setTimeout(() => els.richInput?.focus(), 80);
        }
    }

    const AGENT_POPOVERS = [
        { key: 'attach', btn: 'uploadBtn', pop: 'attachPopover', width: 196, maxHeight: 130 },
        { key: 'model', btn: 'modelBtn', pop: 'modelPopover', width: 396, maxHeight: 455 },
        { key: 'skill', btn: 'skillBtn', pop: 'skillPopover', width: 420, maxHeight: 430 },
        { key: 'size', btn: 'sizeBtn', pop: 'sizePopover', width: 344, maxHeight: 340 },
        { key: 'mode', btn: 'autoRunBtn', pop: 'modePopover', width: 268, maxHeight: 200 },
        { key: 'mention', btn: 'composerBox', pop: 'mentionPopover', width: 356, maxHeight: 350 }
    ];

    function positionAgentPopover(triggerEl, popEl, opts = {}) {
        if (!popEl) return;
        const anchor = triggerEl || els.composerBox || els.panel;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.min(opts.width || 340, Math.max(180, vw - 24));
        const availAbove = Math.max(140, rect.top - 16);
        const maxHeight = Math.min(opts.maxHeight || 430, availAbove, vh - 32);
        const left = Math.max(12, Math.min(vw - width - 12, rect.left));

        popEl.style.setProperty('--sa-pop-width', `${Math.round(width)}px`);
        popEl.style.setProperty('--sa-pop-max-height', `${Math.round(maxHeight)}px`);
        popEl.style.setProperty('--sa-pop-left', `${Math.round(left)}px`);
        popEl.style.setProperty('--sa-pop-top', `${Math.max(12, Math.round(rect.top - maxHeight - 8))}px`);

        requestAnimationFrame(() => {
            if (!popEl.classList.contains('open')) return;
            const box = popEl.getBoundingClientRect();
            const actualH = Math.min(maxHeight, Math.ceil(box.height || popEl.scrollHeight || 160));
            const nextTop = rect.top - actualH - 8 >= 12
                ? rect.top - actualH - 8
                : Math.min(vh - actualH - 12, rect.bottom + 8);
            popEl.style.setProperty('--sa-pop-top', `${Math.max(12, Math.round(nextTop))}px`);
        });
    }

    function closeAllAgentPopovers(exceptPopId = '') {
        AGENT_POPOVERS.forEach(item => {
            const popEl = els[item.pop];
            const btnEl = els[item.btn];
            if (popEl && popEl.id === exceptPopId) return;
            popEl?.classList.remove('open');
            if (item.btn !== 'composerBox') btnEl?.classList.remove('open');
        });
        if (exceptPopId !== 'saHistoryDrawer') els.historyDrawer?.classList.remove('open');
        if (exceptPopId !== 'saSysDrawer') els.sysDrawer?.classList.remove('open');
        if (exceptPopId !== 'saMentionPopover') state.mentionOpen = false;
    }

    function toggleAgentComposerPopover(key, force) {
        const cfg = AGENT_POPOVERS.find(it => it.key === key);
        if (!cfg) return false;
        const btnEl = els[cfg.btn];
        const popEl = els[cfg.pop];
        if (!popEl) return false;
        const shouldOpen = typeof force === 'boolean' ? force : !popEl.classList.contains('open');
        if (shouldOpen) {
            closeAllAgentPopovers(popEl.id);
            if (cfg.btn !== 'composerBox') btnEl?.classList.add('open');
            popEl.classList.add('open');
            positionAgentPopover(btnEl, popEl, cfg);
            if (window.lucide) lucide.createIcons({ nodes: [popEl] });
        } else {
            if (cfg.btn !== 'composerBox') btnEl?.classList.remove('open');
            popEl.classList.remove('open');
        }
        return shouldOpen;
    }

    /* ===== Node Outline & Cmd+F Global Search Rendering ===== */
    function toggleOutlinePanel(force) {
        state.outlineOpen = typeof force === 'boolean' ? force : !state.outlineOpen;
        els.outlinePanel.classList.toggle('open', state.outlineOpen);
        if (state.outlineOpen) {
            renderOutlineList();
            setTimeout(() => els.outlineSearch?.focus(), 40);
        }
    }

    function updateOutlineBadgeCount() {
        const count = sortedAllCanvasNodes().length;
        if (els.outlineCount) els.outlineCount.textContent = String(count);
        if (state.outlineOpen) renderOutlineList();
    }

    function renderOutlineList() {
        if (!els.outlineList) return;
        const all = sortedAllCanvasNodes();
        const starredTotal = all.filter(n => n.starred).length;
        if (els.outlineCount) els.outlineCount.textContent = String(all.length);

        els.starExportBar.classList.toggle('visible', starredTotal > 0);
        els.starExportText.textContent = `已标记 ${starredTotal} 个 ⭐ 定稿节点`;

        els.outlineTabs.querySelectorAll('[data-otab]').forEach(btn => {
            const tab = btn.dataset.otab;
            btn.classList.toggle('active', tab === state.outlineTab);
            if (tab === 'starred') btn.textContent = `⭐ 定稿${starredTotal ? ` (${starredTotal})` : ''}`;
        });

        const q = (state.outlineQuery || '').trim().toLowerCase();
        const filtered = all.filter((node, idx) => {
            const isGen = Boolean(node.runAt || node.runPrompt);
            const isImg = typeof isSmartImageNode === 'function' ? isSmartImageNode(node) : (!node.type || node.type === 'smart-image');
            if (state.outlineTab === 'starred' && !node.starred) return false;
            if (state.outlineTab === 'generated' && !isGen) return false;
            if (state.outlineTab === 'source' && (!isImg || isGen || !(node.images || []).length)) return false;
            if (state.outlineTab === 'other' && isImg) return false;

            if (!q) return true;
            const title = nodeSemanticTitle(node).toLowerCase();
            const prompt = String(node.runPrompt || node.promptDraftText || node.text || '').toLowerCase();
            const imgNames = (node.images || []).map(it => `${it.name || ''} ${it.url || ''}`).join(' ').toLowerCase();
            const mdl = String(node.runSettings?.model || '').toLowerCase();
            return title.includes(q) || prompt.includes(q) || imgNames.includes(q) || mdl.includes(q) || `#${idx + 1}`.includes(q);
        });

        if (!filtered.length) {
            els.outlineList.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:12px;color:var(--sa-text-muted);">没有匹配的节点</div>`;
            return;
        }

        const activeSel = typeof selectedNodeIds === 'function' ? new Set(selectedNodeIds()) : new Set();
        els.outlineList.innerHTML = filtered.map((node, i) => {
            const detail = resolveRefItemDetails(node.id, i + 1);
            const subParts = [detail?.kindLabel || '节点'];
            if (node.runSettings?.model) subParts.push(shortModelLabel(node.runSettings.model));
            if (detail?.width && detail?.height) subParts.push(`${detail.width}×${detail.height}`);
            return `<div class="sa-outline-row ${activeSel.has(node.id) ? 'active' : ''}" data-outline-id="${escapeHtml(node.id)}">
                ${detail?.thumb
                    ? `<img class="sa-outline-thumb" src="${escapeHtml(detail.thumb)}" loading="lazy" alt="">`
                    : `<span class="sa-outline-thumb">${escapeHtml((detail?.kindLabel || '#').slice(0, 2))}</span>`}
                <div class="sa-outline-info">
                    <div class="sa-outline-name">${node.starred ? '⭐ ' : ''}${escapeHtml(detail?.title || '节点')}</div>
                    <div class="sa-outline-sub">${escapeHtml(subParts.join(' · '))}</div>
                </div>
                <div class="sa-outline-acts">
                    <button type="button" class="sa-outline-mini ${node.starred ? 'starred' : ''}" data-outline-star="${escapeHtml(node.id)}" title="标记定稿">★</button>
                    <button type="button" class="sa-outline-mini" data-outline-ref="${escapeHtml(node.id)}" title="插入到 Agent 输入框">+引用</button>
                </div>
            </div>`;
        }).join('');

        els.outlineList.querySelectorAll('[data-outline-id]').forEach(row => {
            row.onclick = e => {
                if (e.target.closest('[data-outline-star], [data-outline-ref]')) return;
                focusCanvasNodeById(row.dataset.outlineId, true);
                renderOutlineList();
            };
        });
        els.outlineList.querySelectorAll('[data-outline-star]').forEach(btn => {
            btn.onclick = e => {
                e.stopPropagation();
                toggleNodeStarred(btn.dataset.outlineStar);
            };
        });
        els.outlineList.querySelectorAll('[data-outline-ref]').forEach(btn => {
            btn.onclick = e => {
                e.stopPropagation();
                if (!state.open) setAgentOpen(true);
                insertInlineTokenIntoAgentInput(btn.dataset.outlineRef, { focusInput: true, allowDuplicateAdjacent: true });
            };
        });
    }

    /* ===== Dragging Orb, Floating Card Magnetic Snap & Dock Tear-Off + Resizers ===== */
    function bindDraggable(handleEl, targetEl, onClickWithoutMove, onSavePos) {
        handleEl.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('button') && handleEl !== e.target && handleEl !== els.orbBtn) return;
            const rect = targetEl.getBoundingClientRect();
            const startX = e.clientX, startY = e.clientY;
            let moved = false;
            const onMove = ev => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 5) moved = true;
                if (moved) {
                    const maxLeft = Math.max(10, window.innerWidth - rect.width - 10);
                    const maxTop = Math.max(10, window.innerHeight - Math.min(rect.height, 120) - 10);
                    targetEl.style.left = `${Math.round(Math.max(10, Math.min(maxLeft, rect.left + dx)))}px`;
                    targetEl.style.top = `${Math.round(Math.max(10, Math.min(maxTop, rect.top + dy)))}px`;
                    targetEl.style.right = 'auto';
                    targetEl.style.bottom = 'auto';
                }
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (moved) {
                    const finalRect = targetEl.getBoundingClientRect();
                    onSavePos?.({ left: Math.round(finalRect.left), top: Math.round(finalRect.top) });
                } else {
                    onClickWithoutMove?.();
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function bindAgentPanelDragAndSnap() {
        els.header.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            if (e.target.closest('button')) return;
            if (window.innerWidth <= 720) return;

            const startRect = els.panel.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            let dragMode = state.layoutMode === 'floating' ? 'floating' : 'docked';
            let dragRect = {
                left: startRect.left,
                top: startRect.top,
                width: startRect.width,
                height: startRect.height
            };
            let moved = false;
            let lastSnap = null;

            const onMove = ev => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) <= 5) return;

                if (dragMode === 'docked') {
                    // Tear off seamlessly into floating card when dragged away from right edge
                    if (dx <= -32 || Math.hypot(dx, dy) >= 42) {
                        moved = true;
                        closeAllAgentPopovers();
                        const baseFloat = normalizeAgentFloatRect(state.floatRect);
                        const relX = Math.max(0.15, Math.min(0.85, (startX - startRect.left) / Math.max(1, startRect.width)));
                        const relY = Math.max(10, Math.min(36, startY - startRect.top));
                        const initialLeft = Math.max(12, Math.min(window.innerWidth - baseFloat.width - 12, ev.clientX - relX * baseFloat.width));
                        const initialTop = Math.max(56, Math.min(window.innerHeight - baseFloat.height - 14, ev.clientY - relY));

                        dragMode = 'floating';
                        state.layoutMode = 'floating';
                        document.body.classList.remove('sa-panel-docked-open');
                        els.panel.classList.remove('is-docked');
                        els.panel.classList.add('is-floating', 'is-dragging');
                        els.panel.style.width = `${baseFloat.width}px`;
                        els.panel.style.height = `${baseFloat.height}px`;
                        els.panel.style.right = 'auto';
                        els.panel.style.bottom = 'auto';
                        dragRect = {
                            left: initialLeft - dx,
                            top: initialTop - dy,
                            width: baseFloat.width,
                            height: baseFloat.height
                        };
                    } else {
                        return;
                    }
                } else if (!moved) {
                    moved = true;
                    closeAllAgentPopovers();
                    els.panel.classList.add('is-dragging');
                }

                const rawLeft = dragRect.left + dx;
                const rawTop = dragRect.top + dy;
                const clampedLeft = Math.max(8, Math.min(window.innerWidth - dragRect.width - 8, rawLeft));
                const clampedTop = Math.max(56, Math.min(window.innerHeight - dragRect.height - 10, rawTop));

                els.panel.style.left = `${Math.round(clampedLeft)}px`;
                els.panel.style.top = `${Math.round(clampedTop)}px`;

                lastSnap = computeAgentFloatSnap(
                    { left: clampedLeft, top: clampedTop, width: dragRect.width, height: dragRect.height },
                    ev.clientX,
                    window.innerWidth,
                    window.innerHeight
                );
                els.dockSnapZone.classList.toggle('visible', lastSnap.shouldDock);
                els.panel.classList.toggle('is-snap-primed', lastSnap.shouldDock);
            };

            const onUp = ev => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                els.panel.classList.remove('is-dragging', 'is-snap-primed');
                els.dockSnapZone.classList.remove('visible');

                if (!moved) return;

                if (dragMode === 'floating') {
                    const finalRect = els.panel.getBoundingClientRect();
                    const snap = lastSnap || computeAgentFloatSnap(
                        { left: finalRect.left, top: finalRect.top, width: dragRect.width, height: dragRect.height },
                        ev.clientX,
                        window.innerWidth,
                        window.innerHeight
                    );
                    if (snap.shouldDock) {
                        setPanelLayoutMode('docked', { animate: true, toast: true });
                    } else {
                        state.layoutMode = 'floating';
                        state.floatRect = {
                            left: snap.left,
                            top: snap.top,
                            width: snap.width,
                            height: snap.height
                        };
                        syncPanelLayoutUi(true);
                        saveAgentSettings();
                    }
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        els.header.addEventListener('dblclick', e => {
            if (e.target.closest('button')) return;
            setPanelLayoutMode(state.layoutMode === 'docked' ? 'floating' : 'docked', { animate: true, toast: true });
        });
    }

    function bindAgentPanelResizers() {
        els.dockResizeHandle?.addEventListener('mousedown', e => {
            if (e.button !== 0 || state.layoutMode !== 'docked') return;
            e.preventDefault();
            e.stopPropagation();
            closeAllAgentPopovers();
            const startX = e.clientX;
            const startW = state.dockWidth;
            els.dockResizeHandle.classList.add('active');
            els.panel.classList.add('is-dragging');

            const onMove = ev => {
                const maxAllowed = Math.min(AGENT_LAYOUT_DEFAULTS.dockWidthMax, Math.max(AGENT_LAYOUT_DEFAULTS.dockWidthMin, window.innerWidth - 280));
                const nextW = Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.dockWidthMin, Math.min(maxAllowed, startW + (startX - ev.clientX))));
                state.dockWidth = nextW;
                document.documentElement.style.setProperty('--sa-dock-width', `${nextW}px`);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                els.dockResizeHandle.classList.remove('active');
                els.panel.classList.remove('is-dragging');
                saveAgentSettings();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        els.floatResizeHandle?.addEventListener('mousedown', e => {
            if (e.button !== 0 || state.layoutMode !== 'floating') return;
            e.preventDefault();
            e.stopPropagation();
            closeAllAgentPopovers();
            const startX = e.clientX;
            const startY = e.clientY;
            const rect = els.panel.getBoundingClientRect();
            els.panel.classList.add('is-dragging');

            const onMove = ev => {
                const maxW = Math.min(AGENT_LAYOUT_DEFAULTS.floatMaxW, window.innerWidth - rect.left - 12);
                const maxH = window.innerHeight - rect.top - 12;
                const nextW = Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.floatMinW, Math.min(maxW, rect.width + (ev.clientX - startX))));
                const nextH = Math.round(Math.max(AGENT_LAYOUT_DEFAULTS.floatMinH, Math.min(maxH, rect.height + (ev.clientY - startY))));
                els.panel.style.width = `${nextW}px`;
                els.panel.style.height = `${nextH}px`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                els.panel.classList.remove('is-dragging');
                const finalRect = els.panel.getBoundingClientRect();
                state.floatRect = normalizeAgentFloatRect({
                    left: finalRect.left,
                    top: finalRect.top,
                    width: finalRect.width,
                    height: finalRect.height
                });
                syncPanelLayoutUi(false);
                saveAgentSettings();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    /* ===== Event Bindings ===== */
    function bindAgentEvents() {
        // Outline events + Cmd/Ctrl+F shortcut
        els.outlineBtn.onclick = () => toggleOutlinePanel();
        els.outlineCloseBtn.onclick = () => toggleOutlinePanel(false);
        els.outlineSearch.addEventListener('input', () => {
            state.outlineQuery = els.outlineSearch.value;
            renderOutlineList();
        });
        els.outlineTabs.querySelectorAll('[data-otab]').forEach(btn => {
            btn.onclick = () => {
                state.outlineTab = btn.dataset.otab;
                renderOutlineList();
            };
        });
        els.downloadStarredBtn.onclick = () => downloadAllStarredNodesZip();

        window.addEventListener('keydown', e => {
            if ((e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === 'f') {
                e.preventDefault();
                toggleOutlinePanel(true);
            }
        });

        bindDraggable(
            els.orbBtn,
            els.orbWrap,
            () => setAgentOpen(true),
            pos => { state.orbPos = pos; saveAgentSettings(); }
        );
        bindAgentPanelDragAndSnap();
        bindAgentPanelResizers();

        els.dockToggleBtn.onclick = () => {
            setPanelLayoutMode(state.layoutMode === 'docked' ? 'floating' : 'docked', { animate: true, toast: true });
        };

        els.minimizeBtn.onclick = () => setAgentOpen(false);

        els.clickRefToggleBtn.onclick = () => {
            state.clickToRef = !state.clickToRef;
            els.clickRefToggleBtn.classList.toggle('active', state.clickToRef);
            saveAgentSettings();
            if (typeof toast === 'function') {
                toast(state.clickToRef ? '已开启：点击画布节点自动插入行内引用' : '已关闭点击自动插入（仍可输入 @ 引用）');
            }
        };

        els.focusCanvasBtn.onclick = () => {
            if (typeof fitAllNodesViewport === 'function') fitAllNodesViewport();
        };

        els.newChatBtn.onclick = () => {
            const t = createEmptyThread();
            state.threads.unshift(t);
            state.currentThreadId = t.id;
            saveThreads();
            closeAllAgentPopovers();
            renderThreadView();
        };

        els.threadBtn.onclick = () => {
            const opening = !els.historyDrawer.classList.contains('open');
            closeAllAgentPopovers();
            if (opening) {
                renderHistoryDrawer();
                els.historyDrawer.classList.add('open');
                if (window.lucide) lucide.createIcons();
            }
        };
        els.historyClose.onclick = () => els.historyDrawer.classList.remove('open');

        els.sysBtn.onclick = () => {
            const opening = !els.sysDrawer.classList.contains('open');
            closeAllAgentPopovers();
            if (opening) openSysDrawer();
        };
        els.sysClose.onclick = () => els.sysDrawer.classList.remove('open');

        els.syncFromGptBtn.onclick = () => {
            state.promptSource = 'gpt';
            const gpt = readGptChatSettings();
            if (Array.isArray(gpt.chatSkillIds)) state.skillIds = gpt.chatSkillIds.map(String);
            els.sysTextarea.value = effectiveAgentSystemPrompt();
            els.sysSourceBadge.textContent = promptSourceLabel();
            if (window.LLMSkills && els.skillSelect) window.LLMSkills.refreshSelect(els.skillSelect, state.skillIds);
            saveAgentSettings();
            renderPresetStrip();
            updateToolbarLabels();
            if (typeof toast === 'function') toast('已同步 Agent智能改图 中的系统提示词');
        };

        els.skillManageBtn.onclick = () => {
            if (!window.LLMSkills) return;
            window.LLMSkills.openManager({
                selectedIds: state.skillIds,
                onChange(ids) {
                    state.skillIds = ids;
                    saveAgentSettings();
                    window.LLMSkills.refreshSelect(els.skillSelect, state.skillIds);
                    updateToolbarLabels();
                    if (els.skillPopover?.classList.contains('open')) renderSkillPopover();
                }
            });
        };

        els.sysClearBtn.onclick = () => {
            els.sysTextarea.value = '';
            state.promptSource = 'custom';
            state.customSystemPrompt = '';
            saveAgentSettings();
            els.sysSourceBadge.textContent = promptSourceLabel();
            renderPresetStrip();
            updateSysIndicator();
        };

        els.sysSaveBtn.onclick = () => {
            const val = els.sysTextarea.value.trim();
            const gptVal = String(readGptChatSettings().systemPrompt || '').trim();
            const currentExpected = String(effectiveAgentSystemPrompt() || '').trim();
            if (state.promptSource.startsWith('preset:') && val === currentExpected) {
                // Keep preset selection intact when user applies without changing preset text
            } else if (val === gptVal && gptVal) {
                state.promptSource = 'gpt';
                state.customSystemPrompt = val;
            } else {
                state.promptSource = 'custom';
                state.customSystemPrompt = val;
            }
            if (els.skillSelect) state.skillIds = [...els.skillSelect.selectedOptions].map(o => o.value);
            saveAgentSettings();
            els.sysDrawer.classList.remove('open');
            renderPresetStrip();
            updateToolbarLabels();
            if (typeof toast === 'function') toast('Agent 系统提示词已应用');
        };

        els.sysSaveToGptBtn.onclick = () => {
            const val = els.sysTextarea.value.trim();
            const gpt = readGptChatSettings();
            gpt.systemPrompt = val;
            if (els.skillSelect) {
                state.skillIds = [...els.skillSelect.selectedOptions].map(o => o.value);
                gpt.chatSkillIds = state.skillIds;
            }
            writeJsonStorage(GPT_CHAT_SETTINGS_KEY, gpt);
            state.promptSource = 'gpt';
            state.customSystemPrompt = val;
            saveAgentSettings();
            els.sysDrawer.classList.remove('open');
            renderPresetStrip();
            updateToolbarLabels();
            if (typeof toast === 'function') toast('已保存并同步到 Agent智能改图');
        };

        // Mention Search inside Popover
        els.mentionCloseBtn.onclick = () => closeMentionMenu();
        els.mentionSearch.addEventListener('input', () => {
            state.mentionQuery = els.mentionSearch.value.trim().toLowerCase();
            state.mentionActiveIdx = 0;
            renderMentionMenu();
        });
        els.mentionSearch.addEventListener('keydown', e => {
            const items = [...els.mentionList.querySelectorAll('.sa-mention-item')];
            if (e.key === 'ArrowDown' && items.length) {
                e.preventDefault();
                state.mentionActiveIdx = (state.mentionActiveIdx + 1) % items.length;
                highlightMentionOption();
            } else if (e.key === 'ArrowUp' && items.length) {
                e.preventDefault();
                state.mentionActiveIdx = (state.mentionActiveIdx - 1 + items.length) % items.length;
                highlightMentionOption();
            } else if (e.key === 'Enter' && items[state.mentionActiveIdx]) {
                e.preventDefault();
                items[state.mentionActiveIdx].click();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeMentionMenu();
            }
        });

        // Toolbar controls & Portal Popovers
        els.uploadBtn.onclick = e => {
            e.stopPropagation();
            toggleAgentComposerPopover('attach');
        };
        els.attachLocalBtn.onclick = () => {
            closeAllAgentPopovers();
            els.uploadInput.click();
        };
        els.attachMentionBtn.onclick = () => {
            closeAllAgentPopovers();
            state.mentionAtRange = null;
            state.mentionQuery = '';
            state.mentionOpen = true;
            state.mentionActiveIdx = 0;
            if (els.mentionSearch) els.mentionSearch.value = '';
            renderMentionMenu();
            setTimeout(() => els.mentionSearch?.focus(), 30);
        };

        els.uploadInput.onchange = () => {
            if (els.uploadInput.files?.length) {
                uploadFilesIntoCanvasAndAgent([...els.uploadInput.files]);
                els.uploadInput.value = '';
            }
        };

        els.modelBtn.onclick = e => {
            e.stopPropagation();
            if (toggleAgentComposerPopover('model')) renderModelPopover();
        };

        els.scopeImageBtn.onclick = () => { state.modelScopeTab = 'image'; renderModelPopover(); };
        els.scopeChatBtn.onclick = () => { state.modelScopeTab = 'chat'; renderModelPopover(); };

        els.compareToggleBtn.onclick = () => {
            state.compareMode = !state.compareMode;
            if (state.compareMode && !state.compareTargets.length && state.imageProvider && state.imageModel) {
                state.compareTargets = [{ provider: state.imageProvider, model: state.imageModel }];
            }
            saveAgentSettings();
            renderModelPopover();
            updateToolbarLabels();
        };

        els.skillBtn.onclick = e => {
            e.stopPropagation();
            if (toggleAgentComposerPopover('skill')) {
                window.LLMSkills?.load?.().then(() => renderSkillPopover()).catch(() => {});
                renderSkillPopover();
            }
        };

        els.skillCreateBtn.onclick = () => {
            closeAllAgentPopovers();
            els.skillManageBtn?.click();
        };
        els.skillSysBtn.onclick = () => {
            closeAllAgentPopovers();
            openSysDrawer();
        };
        els.skillFilterTabs.querySelectorAll('[data-stab]').forEach(btn => {
            btn.onclick = () => {
                state.skillFilterTab = btn.dataset.stab || 'all';
                renderSkillPopover();
            };
        });
        els.skillSearchInput.addEventListener('input', () => {
            state.skillSearchQuery = els.skillSearchInput.value || '';
            renderSkillPopover();
        });

        els.sizeBtn.onclick = e => {
            e.stopPropagation();
            if (toggleAgentComposerPopover('size')) renderSizePopover();
        };

        els.sizePopover.querySelectorAll('[data-size-mode]').forEach(btn => {
            btn.onclick = () => {
                state.sizeMode = btn.dataset.sizeMode;
                saveAgentSettings();
                renderSizePopover();
                updateToolbarLabels();
            };
        });

        els.autoRunBtn.onclick = e => {
            e.stopPropagation();
            if (toggleAgentComposerPopover('mode')) renderModePopover();
        };

        [els.modeOptManual, els.modeOptAuto].forEach(btn => {
            btn?.addEventListener('click', () => {
                state.autoRun = btn.dataset.autoMode === 'auto';
                saveAgentSettings();
                renderModePopover();
                updateToolbarLabels();
                closeAllAgentPopovers();
            });
        });

        // Rich contenteditable input events
        ['keyup', 'mouseup', 'focus'].forEach(evtName => {
            els.richInput.addEventListener(evtName, () => saveAgentCaretRange());
        });

        els.richInput.addEventListener('input', () => {
            saveAgentCaretRange();
            syncSendButtonState();
            detectRichInputAtMention();
        });

        els.richInput.addEventListener('keydown', e => {
            if (state.mentionOpen) {
                const items = [...els.mentionList.querySelectorAll('.sa-mention-item')];
                if (e.key === 'ArrowDown' && items.length) {
                    e.preventDefault();
                    state.mentionActiveIdx = (state.mentionActiveIdx + 1) % items.length;
                    highlightMentionOption();
                    return;
                }
                if (e.key === 'ArrowUp' && items.length) {
                    e.preventDefault();
                    state.mentionActiveIdx = (state.mentionActiveIdx - 1 + items.length) % items.length;
                    highlightMentionOption();
                    return;
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && items[state.mentionActiveIdx]) {
                    e.preventDefault();
                    items[state.mentionActiveIdx].click();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeMentionMenu();
                    return;
                }
            }
            // Cleanly delete adjacent inline token on Backspace
            if (e.key === 'Backspace') {
                const sel = window.getSelection();
                if (sel && sel.rangeCount && sel.isCollapsed) {
                    const r = sel.getRangeAt(0);
                    if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset === 0 && r.startContainer.previousSibling?.classList?.contains?.('sa-inline-token')) {
                        e.preventDefault();
                        r.startContainer.previousSibling.remove();
                        syncSendButtonState();
                        return;
                    }
                }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sendAgentMessage();
            }
        });

        els.sendBtn.onclick = () => {
            if (state.sending) {
                state.abortController?.abort();
                return;
            }
            sendAgentMessage();
        };

        // Close open portal popovers when clicking outside them or their toolbar trigger buttons
        const triggerSelector = '#saUploadBtn, #saModelBtn, #saSkillBtn, #saSizeBtn, #saAutoRunBtn';
        document.addEventListener('mousedown', e => {
            if (e.target.closest('.sa-popover') || e.target.closest(triggerSelector)) return;
            AGENT_POPOVERS.forEach(item => {
                if (item.key === 'mention' && state.mentionOpen && e.target.closest('#saRichInput')) return;
                els[item.pop]?.classList.remove('open');
                if (item.btn !== 'composerBox') els[item.btn]?.classList.remove('open');
                if (item.key === 'mention') state.mentionOpen = false;
            });
        }, true);

        els.composerBox.addEventListener('dragover', e => {
            if ([...(e.dataTransfer?.items || [])].some(it => it.kind === 'file')) {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        els.composerBox.addEventListener('drop', e => {
            const files = [...(e.dataTransfer?.files || [])].filter(f => /^(image|video)\//i.test(f.type));
            if (files.length) {
                e.preventDefault();
                e.stopPropagation();
                uploadFilesIntoCanvasAndAgent(files);
            }
        });

        window.addEventListener('resize', () => {
            syncPanelLayoutUi(false);
            AGENT_POPOVERS.forEach(cfg => {
                const popEl = els[cfg.pop];
                if (popEl?.classList.contains('open')) {
                    positionAgentPopover(els[cfg.btn], popEl, cfg);
                }
            });
        });

        window.addEventListener('storage', e => {
            if (e.key === GPT_CHAT_SETTINGS_KEY && state.promptSource === 'gpt') {
                updateToolbarLabels();
                renderPresetStrip();
            }
        });
    }

    function syncSendButtonState() {
        if (!els.sendBtn) return;
        const hasContent = richInputHasContent();
        els.sendBtn.classList.toggle('streaming', state.sending);
        els.sendBtn.classList.toggle('ready', !state.sending && hasContent);
        els.sendBtn.innerHTML = state.sending
            ? '<i data-lucide="square"></i>'
            : '<i data-lucide="arrow-up"></i>';
        els.sendBtn.title = state.sending ? '停止生成' : '发送';
        if (window.lucide) lucide.createIcons({ nodes: [els.sendBtn] });
    }

    /* ===== Upload Local Files Directly onto Canvas & Insert Inline Token ===== */
    async function uploadFilesIntoCanvasAndAgent(files) {
        if (!files?.length) return;
        const form = new FormData();
        files.slice(0, 12).forEach(f => form.append('files', f));
        try {
            if (typeof toast === 'function') toast('正在上传并创建画布节点…');
            const res = await fetch('/api/ai/upload', { method: 'POST', body: form });
            if (!res.ok) throw new Error('上传失败');
            const data = await res.json();
            const uploaded = Array.isArray(data.files) ? data.files : [];
            if (!uploaded.length) return;

            const shellRect = shell?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
            const rightClear = state.open
                ? (state.layoutMode === 'docked' ? (state.dockWidth + 24) : 430)
                : 60;
            const visibleW = Math.max(320, shellRect.width - rightClear);
            const baseWorldX = Math.round((visibleW * 0.28 - viewport.x) / viewport.scale);
            const baseWorldY = Math.round((shellRect.height * 0.24 - viewport.y) / viewport.scale);

            if (typeof pushUndo === 'function') pushUndo();
            const createdIds = [];
            uploaded.forEach((fileItem, idx) => {
                const cleanName = String(fileItem.name || `素材_${idx + 1}`).replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 22);
                const mediaItem = {
                    url: fileItem.url,
                    name: fileItem.name || `upload-${idx + 1}.png`,
                    kind: /^video\//i.test(fileItem.mime || '') ? 'video' : 'image'
                };
                const created = createNode(baseWorldX, baseWorldY + idx * 290, [mediaItem], { skipUndo: true, select: false });
                if (created) {
                    if (cleanName) created.title = cleanName;
                    createdIds.push(created.id);
                }
            });
            if (typeof measureSmartNodeImages === 'function') measureSmartNodeImages();
            if (typeof render === 'function') render();
            if (typeof scheduleSave === 'function') scheduleSave();

            createdIds.forEach(cid => {
                insertInlineTokenIntoAgentInput(cid, { focusInput: true, allowDuplicateAdjacent: true });
            });
            if (typeof toast === 'function') toast(`已上传 ${createdIds.length} 个节点并插入行内引用`);
        } catch (err) {
            if (typeof toast === 'function') toast(err.message || '上传失败');
        }
    }

    /* ===== @Mention Detection inside Contenteditable `#saRichInput` ===== */
    function detectRichInputAtMention() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) {
            closeMentionMenu();
            return;
        }
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) {
            closeMentionMenu();
            return;
        }
        const textBefore = (range.startContainer.textContent || '').slice(0, range.startOffset);
        const m = textBefore.match(/(?:^|[^a-zA-Z0-9._-])@([^\s@]*)$/);
        if (!m) {
            closeMentionMenu();
            return;
        }
        const query = m[1] || '';
        const atOffset = range.startOffset - query.length - 1;
        const replaceRange = document.createRange();
        replaceRange.setStart(range.startContainer, Math.max(0, atOffset));
        replaceRange.setEnd(range.startContainer, range.startOffset);

        state.mentionAtRange = replaceRange;
        state.mentionQuery = query.toLowerCase();
        state.mentionOpen = true;
        state.mentionActiveIdx = 0;
        if (els.mentionSearch) els.mentionSearch.value = query;
        renderMentionMenu();
    }

    function renderMentionMenu() {
        const allEntries = buildAllMentionableEntries();
        const q = (state.mentionQuery || '').trim();
        const filtered = allEntries.filter(entry => {
            if (!q) return true;
            const hay = `#${entry.canvasNumber} ${entry.title} ${entry.kindLabel} ${entry.text} ${entry.id}`.toLowerCase();
            return hay.includes(q);
        });

        if (els.mentionHeadTitle) {
            els.mentionHeadTitle.textContent = `插入节点引用（共 ${filtered.length}/${allEntries.length} 项）`;
        }

        const openMentionPopover = () => {
            closeAllAgentPopovers('saMentionPopover');
            els.mentionPopover.classList.add('open');
            const cfg = AGENT_POPOVERS.find(it => it.key === 'mention');
            positionAgentPopover(els.composerBox, els.mentionPopover, cfg);
            if (window.lucide) lucide.createIcons({ nodes: [els.mentionPopover] });
        };

        if (!filtered.length) {
            els.mentionList.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--sa-text-muted);text-align:center;">未找到匹配节点</div>`;
            openMentionPopover();
            return;
        }

        els.mentionList.innerHTML = filtered.map((entry, i) => {
            const subSnippet = entry.text
                ? entry.text.slice(0, 38)
                : `${entry.kindLabel}${entry.width && entry.height ? ` · ${entry.width}×${entry.height}` : ''}`;
            return `<button type="button" class="sa-mention-item ${i === state.mentionActiveIdx ? 'active' : ''}" data-ref-key="${escapeHtml(entry.id)}">
                ${entry.thumb
                    ? `<img class="sa-mention-thumb" src="${escapeHtml(entry.thumb)}" loading="lazy" alt="">`
                    : `<span class="sa-mention-thumb">#${entry.canvasNumber}</span>`}
                <div class="sa-mention-meta">
                    <div class="sa-mention-title">${escapeHtml(entry.title)}</div>
                    <div class="sa-mention-sub">#${entry.canvasNumber} · ${escapeHtml(subSnippet)}</div>
                </div>
            </button>`;
        }).join('');
        openMentionPopover();

        els.mentionList.querySelectorAll('.sa-mention-item').forEach(btn => {
            btn.onclick = () => {
                const rk = btn.dataset.refKey;
                const replaceRange = state.mentionAtRange;
                closeMentionMenu();
                insertInlineTokenIntoAgentInput(rk, {
                    replaceRange,
                    focusInput: true,
                    allowDuplicateAdjacent: true
                });
            };
        });
    }

    function highlightMentionOption() {
        const items = [...els.mentionList.querySelectorAll('.sa-mention-item')];
        items.forEach((el, idx) => {
            const active = idx === state.mentionActiveIdx;
            el.classList.toggle('active', active);
            if (active) el.scrollIntoView({ block: 'nearest' });
        });
    }

    function closeMentionMenu() {
        state.mentionOpen = false;
        state.mentionAtRange = null;
        els.mentionPopover?.classList.remove('open');
    }

    /* ===== Sub-Components (System Prompt, Presets, Model Cards, Skill Popover, Mode, Size) ===== */
    function openSysDrawer() {
        els.sysTextarea.value = effectiveAgentSystemPrompt();
        els.sysSourceBadge.textContent = promptSourceLabel();
        renderPresetStrip();
        if (window.LLMSkills && els.skillSelect) window.LLMSkills.refreshSelect(els.skillSelect, effectiveSkillIds());
        els.sysDrawer.classList.add('open');
        if (window.lucide) lucide.createIcons();
    }

    function updateSysIndicator() {
        els.sysBtn?.classList.toggle('has-dot', Boolean(effectiveAgentSystemPrompt()));
    }

    function renderPresetStrip() {
        if (!els.presetStrip) return;
        const presets = allPromptLibraryPresets().slice(0, 12);
        const chips = [];
        const isGpt = state.promptSource === 'gpt';
        chips.push(`
            <button type="button" class="sa-preset-chip ${isGpt ? 'active' : ''}" data-preset-source="gpt" title="使用 Agent智能改图 中的系统提示词">
                <i data-lucide="bot"></i><span>智能改图词</span>${isGpt ? '<span class="sa-chip-dot"></span>' : ''}
            </button>
        `);
        presets.forEach(p => {
            const key = `preset:${p.id}`;
            const active = state.promptSource === key;
            const icon = /编辑|融合/.test(p.name) ? 'wand-sparkles' : (/分镜|宫格/.test(p.name) ? 'clapperboard' : 'sparkles');
            chips.push(`
                <button type="button" class="sa-preset-chip ${active ? 'active' : ''}" data-preset-source="${escapeHtml(key)}" title="${escapeHtml(p.name)}">
                    <i data-lucide="${icon}"></i>
                    <span>${escapeHtml(p.name.length > 15 ? p.name.slice(0, 15) + '…' : p.name)}</span>
                    ${active ? '<span class="sa-chip-dot"></span>' : ''}
                </button>
            `);
        });
        if (state.promptSource === 'custom' && state.customSystemPrompt.trim()) {
            chips.unshift(`
                <button type="button" class="sa-preset-chip active" data-preset-source="custom">
                    <i data-lucide="sliders-horizontal"></i><span>自定义系统词</span><span class="sa-chip-dot"></span>
                </button>
            `);
        }
        els.presetStrip.innerHTML = chips.join('');
        els.presetStrip.querySelectorAll('[data-preset-source]').forEach(btn => {
            btn.onclick = () => {
                state.promptSource = btn.dataset.presetSource;
                saveAgentSettings();
                if (els.sysTextarea) els.sysTextarea.value = effectiveAgentSystemPrompt();
                if (els.sysSourceBadge) els.sysSourceBadge.textContent = promptSourceLabel();
                renderPresetStrip();
                updateSysIndicator();
                if (typeof toast === 'function') toast(promptSourceLabel());
            };
        });
        if (window.lucide) lucide.createIcons({ nodes: [els.presetStrip] });
    }

    function updateToolbarLabels() {
        ensureValidModels();
        const targets = activeImageTargetModels();
        if (els.modelBtnLabel) {
            els.modelBtnLabel.textContent = targets.length > 1
                ? `对比 ${targets.length} 模型`
                : shortModelLabel(state.imageModel || '生图');
            els.modelBtn.classList.toggle('active', targets.length > 1);
            els.modelBtn.title = `大脑: ${state.chatModel || '默认'} | 生图: ${targets.map(t => shortModelLabel(t.model)).join(' + ')}`;
        }
        if (els.skillBadgeCount) {
            const activeSkills = effectiveSkillIds();
            els.skillBadgeCount.textContent = activeSkills.length ? String(activeSkills.length) : '';
            els.skillBtn?.classList.toggle('active', activeSkills.length > 0);
        }
        if (els.sizeBtnLabel) els.sizeBtnLabel.textContent = sizeSummaryLabel();
        if (els.autoRunBtn && els.autoRunLabel) {
            els.autoRunBtn.classList.toggle('active', state.autoRun);
            els.autoRunLabel.textContent = state.autoRun ? '自动生成' : '手动生成';
            if (els.autoRunIconWrap) {
                els.autoRunIconWrap.innerHTML = `<i data-lucide="${state.autoRun ? 'refresh-cw' : 'hand'}"></i>`;
                if (window.lucide) lucide.createIcons({ nodes: [els.autoRunIconWrap] });
            }
        }
        if (els.clickRefToggleBtn) els.clickRefToggleBtn.classList.toggle('active', state.clickToRef);
        updateSysIndicator();
        syncSendButtonState();
    }

    function describeAgentModelCapability(modelId, isImg) {
        const s = String(modelId || '').toLowerCase();
        if (isImg) {
            if (/fast|turbo|zimage/.test(s)) return '高效生成与编辑，满足高频创作需求';
            if (/pro|ultra|max/.test(s)) return '注重画面细节与复杂指令理解，适合精细创作';
            if (/kling/.test(s)) return '擅长写实图像生成，呈现清晰细节与细腻质感';
            if (/seedream|doubao/.test(s)) return '真实质感生图，支持稳定编辑与参考图融合';
            if (/minimax|h3/.test(s)) return '精准理解创意，支持多图参考与图像编辑';
            if (/gpt-image|dall-e/.test(s)) return '强大指令遵循与图文排版编辑能力';
            if (/banana|gemini/.test(s)) return '多图一致融合与精细局部改图引擎';
            if (/flux|klein|qwen/.test(s)) return '高审美光影与写实摄影材质表现';
            return '高清图像生成与参考图视觉编辑模型';
        }
        if (/gpt-5|o1|o3|o4/.test(s)) return '多模态强推理大脑，擅长拆解复杂改图指令';
        if (/claude/.test(s)) return '细腻审美与长上下文提示词构建助手';
        if (/gemini/.test(s)) return '原生多模态视觉理解，精准反推参考图特征';
        if (/deepseek|qwen/.test(s)) return '高性价比敏捷对话与结构化提示词规划';
        return '视觉分析与 Agent 对话调度引擎';
    }

    function agentModelIcon(modelId, isImg) {
        const s = String(modelId || '').toLowerCase();
        if (isImg) {
            if (/seedream|kling/.test(s)) return 'aperture';
            if (/banana|gemini/.test(s)) return 'wand-sparkles';
            if (/zimage|turbo|fast/.test(s)) return 'zap';
            return 'palette';
        }
        if (/gpt-5|o1|o3|o4/.test(s)) return 'cpu';
        if (/gemini/.test(s)) return 'sparkles';
        return 'bot';
    }

    function renderModelPopover() {
        ensureValidModels();
        const isImg = state.modelScopeTab === 'image';
        els.scopeImageBtn.classList.toggle('active', isImg);
        els.scopeChatBtn.classList.toggle('active', !isImg);
        els.compareBar.style.display = isImg ? 'flex' : 'none';
        els.compareToggleBtn.style.display = isImg ? 'inline-flex' : 'none';
        els.compareToggleBtn.classList.toggle('active', state.compareMode);
        els.compareToggleBtn.textContent = state.compareMode
            ? `多模型对比 (${state.compareTargets.length})`
            : '多模型对比';

        const providers = isImg ? availableImageProviders() : availableChatProviders();
        const activePid = isImg ? state.imageProvider : state.chatProvider;
        const currentProv = providers.find(p => p.id === activePid) || providers[0];
        const models = currentProv?.models || [];
        const activeMdl = isImg ? state.imageModel : state.chatModel;

        els.providerList.innerHTML = providers.length
            ? providers.map(p => {
                const countInProv = (isImg && state.compareMode)
                    ? state.compareTargets.filter(ct => ct.provider === p.id).length
                    : 0;
                return `<button type="button" class="sa-provider-pill ${p.id === currentProv?.id ? 'active' : ''}" data-prov="${escapeHtml(p.id)}">
                    <span>${escapeHtml(p.name)}</span>
                    ${countInProv > 0 ? `<small>${countInProv}</small>` : ''}
                </button>`;
            }).join('')
            : '<div class="sa-provider-pill">暂无可用线路</div>';

        els.modelList.innerHTML = models.length
            ? models.map(m => {
                const label = isImg && currentProv?.id === 'modelscope'
                    ? (MS_AGENT_IMAGE_MODELS.find(x => x.id === m)?.name || m)
                    : shortModelLabel(m);
                const isChecked = isImg && state.compareMode
                    ? state.compareTargets.some(ct => ct.provider === currentProv.id && ct.model === m)
                    : (m === activeMdl);
                const desc = describeAgentModelCapability(m, isImg);
                const icon = agentModelIcon(m, isImg);
                return `<button type="button" class="sa-model-card-row ${isChecked ? 'active' : ''}" data-mdl="${escapeHtml(m)}" title="${escapeHtml(m)}">
                    <span class="sa-model-card-badge"><i data-lucide="${icon}"></i></span>
                    <span class="sa-model-card-meta">
                        <div class="sa-model-card-name">${escapeHtml(label)}</div>
                        <div class="sa-model-card-desc">${escapeHtml(desc)}</div>
                    </span>
                    ${(isImg && state.compareMode)
                        ? `<span class="sa-opt-check">${isChecked ? '✓' : ''}</span>`
                        : `<span class="sa-model-card-status"><i data-lucide="${isChecked ? 'check' : 'plus'}"></i></span>`}
                </button>`;
            }).join('')
            : '<div style="padding:18px 10px;text-align:center;font-size:12px;color:var(--sa-text-muted);">暂无可用模型</div>';

        if (window.lucide) lucide.createIcons({ nodes: [els.modelList] });

        els.providerList.querySelectorAll('[data-prov]').forEach(btn => {
            btn.onclick = () => {
                const pid = btn.dataset.prov;
                const found = providers.find(p => p.id === pid);
                if (isImg) {
                    state.imageProvider = pid;
                    if (!state.compareMode) state.imageModel = found?.models?.[0] || '';
                } else {
                    state.chatProvider = pid;
                    state.chatModel = found?.models?.[0] || '';
                }
                saveAgentSettings();
                renderModelPopover();
                updateToolbarLabels();
            };
        });

        els.modelList.querySelectorAll('[data-mdl]').forEach(btn => {
            btn.onclick = () => {
                const mdl = btn.dataset.mdl;
                if (isImg && state.compareMode) {
                    const pid = currentProv.id;
                    const idx = state.compareTargets.findIndex(ct => ct.provider === pid && ct.model === mdl);
                    if (idx >= 0) {
                        if (state.compareTargets.length > 1) state.compareTargets.splice(idx, 1);
                    } else {
                        if (state.compareTargets.length >= 4) {
                            if (typeof toast === 'function') toast('最多同时对比 4 个生图模型');
                            return;
                        }
                        state.compareTargets.push({ provider: pid, model: mdl });
                    }
                    state.imageProvider = state.compareTargets[0].provider;
                    state.imageModel = state.compareTargets[0].model;
                    saveAgentSettings();
                    renderModelPopover();
                    updateToolbarLabels();
                    return;
                }
                if (isImg) state.imageModel = mdl;
                else state.chatModel = mdl;
                saveAgentSettings();
                renderModelPopover();
                updateToolbarLabels();
                closeAllAgentPopovers();
            };
        });
    }

    function renderSkillPopover() {
        if (!els.skillItemsList) return;
        els.skillFilterTabs?.querySelectorAll('[data-stab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.stab === state.skillFilterTab);
        });

        const query = String(state.skillSearchQuery || '').trim().toLowerCase();
        const activeSkillSet = new Set(effectiveSkillIds());
        const skillsList = (window.LLMSkills?.list || []).map(s => ({
            kind: 'skill',
            id: String(s.id),
            title: s.name || s.id,
            slug: `/skill/${String(s.id).slice(0, 18)}`,
            desc: s.description || (s.content || '').replace(/\s+/g, ' ').slice(0, 80) || '自定义工作流与提示词规范',
            active: activeSkillSet.has(String(s.id))
        }));
        const presetsList = allPromptLibraryPresets().map(p => ({
            kind: 'preset',
            id: String(p.id),
            title: p.name,
            slug: '/preset',
            desc: p.text.replace(/\s+/g, ' ').slice(0, 80),
            active: state.promptSource === `preset:${p.id}`
        }));

        let combined = [];
        if (state.skillFilterTab === 'skills') combined = skillsList;
        else if (state.skillFilterTab === 'presets') combined = presetsList;
        else if (state.skillFilterTab === 'active') combined = [...skillsList, ...presetsList].filter(i => i.active);
        else combined = [...skillsList, ...presetsList];

        if (query) {
            combined = combined.filter(item =>
                item.title.toLowerCase().includes(query) ||
                item.desc.toLowerCase().includes(query) ||
                item.slug.toLowerCase().includes(query)
            );
        }

        if (!combined.length) {
            els.skillItemsList.innerHTML = `<div style="padding:18px 10px;text-align:center;font-size:12px;color:var(--sa-text-muted);">没有匹配的 Skill 或预设词，可点击右上角「+ 创建」添加</div>`;
            return;
        }

        els.skillItemsList.innerHTML = combined.map(item => {
            if (item.kind === 'skill') {
                return `<button type="button" class="sa-skill-row-item ${item.active ? 'active' : ''}" data-skill-toggle="${escapeHtml(item.id)}">
                    <span class="sa-skill-row-icon"><i data-lucide="wrench"></i></span>
                    <span class="sa-skill-row-main">
                        <span class="sa-skill-row-top">
                            <span class="sa-skill-row-title">${escapeHtml(item.title)}</span>
                            <span class="sa-skill-row-slug">${escapeHtml(item.slug)}</span>
                        </span>
                        <div class="sa-skill-row-desc">${escapeHtml(item.desc)}</div>
                    </span>
                    <span class="sa-skill-row-act">${item.active ? '已启用' : '启用'}</span>
                </button>`;
            }
            return `<button type="button" class="sa-skill-row-item ${item.active ? 'active' : ''}" data-preset-apply="${escapeHtml(item.id)}">
                <span class="sa-skill-row-icon"><i data-lucide="wand-2"></i></span>
                <span class="sa-skill-row-main">
                    <span class="sa-skill-row-top">
                        <span class="sa-skill-row-title">${escapeHtml(item.title)}</span>
                        <span class="sa-skill-row-slug">${escapeHtml(item.slug)}</span>
                    </span>
                    <div class="sa-skill-row-desc">${escapeHtml(item.desc)}</div>
                </span>
                <span class="sa-skill-row-act">${item.active ? '已应用' : '应用'}</span>
            </button>`;
        }).join('');

        if (window.lucide) lucide.createIcons({ nodes: [els.skillItemsList] });

        els.skillItemsList.querySelectorAll('[data-skill-toggle]').forEach(btn => {
            btn.onclick = () => {
                const sid = String(btn.dataset.skillToggle);
                const idx = state.skillIds.indexOf(sid);
                if (idx >= 0) state.skillIds.splice(idx, 1);
                else state.skillIds.push(sid);
                saveAgentSettings();
                if (window.LLMSkills && els.skillSelect) window.LLMSkills.refreshSelect(els.skillSelect, state.skillIds);
                updateToolbarLabels();
                renderSkillPopover();
            };
        });

        els.skillItemsList.querySelectorAll('[data-preset-apply]').forEach(btn => {
            btn.onclick = () => {
                const pid = String(btn.dataset.presetApply);
                state.promptSource = `preset:${pid}`;
                saveAgentSettings();
                if (els.sysTextarea) els.sysTextarea.value = effectiveAgentSystemPrompt();
                if (els.sysSourceBadge) els.sysSourceBadge.textContent = promptSourceLabel();
                renderPresetStrip();
                updateToolbarLabels();
                renderSkillPopover();
                if (typeof toast === 'function') toast(promptSourceLabel());
            };
        });
    }

    function renderModePopover() {
        els.modeOptManual?.classList.toggle('active', !state.autoRun);
        els.modeOptAuto?.classList.toggle('active', Boolean(state.autoRun));
    }

    function renderSizePopover() {
        els.sizePopover.querySelectorAll('[data-size-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.sizeMode === state.sizeMode);
        });
        if (state.sizeMode === 'auto') {
            els.sizeBody.innerHTML = `<div style="font-size:12px;color:var(--sa-text-sub);line-height:1.55;">默认自动匹配主参考图画幅比例，或按 Agent 识别的目标比例自动设置生图节点尺寸。</div>`;
            return;
        }
        if (state.sizeMode === 'custom') {
            els.sizeBody.innerHTML = `
                <div class="sa-custom-size-row">
                    <input type="number" id="saCustomWInput" min="256" max="8192" step="16" value="${state.customW}" placeholder="宽度">
                    <span style="color:var(--sa-text-sub)">×</span>
                    <input type="number" id="saCustomHInput" min="256" max="8192" step="16" value="${state.customH}" placeholder="高度">
                    <button type="button" class="sa-mini-btn primary" id="saApplyCustomSize">应用</button>
                </div>
                <div style="font-size:11px;color:var(--sa-text-muted);">支持 256 - 8192 像素宽高</div>
            `;
            document.getElementById('saApplyCustomSize').onclick = () => {
                state.customW = Math.max(256, Math.min(8192, Math.round((Number(document.getElementById('saCustomWInput').value) || 1024) / 16) * 16));
                state.customH = Math.max(256, Math.min(8192, Math.round((Number(document.getElementById('saCustomHInput').value) || 1024) / 16) * 16));
                saveAgentSettings();
                updateToolbarLabels();
                closeAllAgentPopovers();
            };
            return;
        }
        const pxPreview = (typeof SIZE_MAP !== 'undefined' && SIZE_MAP[state.ratioKey]?.[state.resTier]) || '1024x1024';
        els.sizeBody.innerHTML = `
            <div class="sa-ratio-grid">
                ${Object.entries(RATIO_KEY_TO_LABEL).map(([key, label]) => `
                    <button type="button" class="sa-ratio-btn ${state.ratioKey === key ? 'active' : ''}" data-ratio-key="${key}">${label}</button>
                `).join('')}
            </div>
            <div class="sa-tier-row">
                ${['1k', '2k', '4k'].map(tier => `
                    <button type="button" class="sa-tier-btn ${state.resTier === tier ? 'active' : ''}" data-res-tier="${tier}">${tier.toUpperCase()}</button>
                `).join('')}
            </div>
            <div style="font-size:11px;color:var(--sa-text-sub);text-align:right;">目标像素：${escapeHtml(pxPreview)}</div>
        `;
        els.sizeBody.querySelectorAll('[data-ratio-key]').forEach(btn => {
            btn.onclick = () => { state.ratioKey = btn.dataset.ratioKey; saveAgentSettings(); renderSizePopover(); updateToolbarLabels(); };
        });
        els.sizeBody.querySelectorAll('[data-res-tier]').forEach(btn => {
            btn.onclick = () => { state.resTier = btn.dataset.resTier; saveAgentSettings(); renderSizePopover(); updateToolbarLabels(); };
        });
    }

    function renderHistoryDrawer() {
        els.threadList.innerHTML = state.threads.map(t => `
            <div class="sa-thread-item ${t.id === state.currentThreadId ? 'active' : ''}" data-tid="${escapeHtml(t.id)}">
                <span class="sa-thread-item-main">${escapeHtml(t.title || '新对话')}</span>
                <button type="button" class="sa-thread-del" data-del-tid="${escapeHtml(t.id)}" title="删除">×</button>
            </div>
        `).join('');
        els.threadList.querySelectorAll('[data-tid]').forEach(row => {
            row.onclick = e => {
                if (e.target.closest('[data-del-tid]')) return;
                state.currentThreadId = row.dataset.tid;
                els.historyDrawer.classList.remove('open');
                renderThreadView();
            };
        });
        els.threadList.querySelectorAll('[data-del-tid]').forEach(btn => {
            btn.onclick = e => {
                e.stopPropagation();
                const id = btn.dataset.delTid;
                state.threads = state.threads.filter(t => t.id !== id);
                if (!state.threads.length) state.threads = [createEmptyThread()];
                if (!state.threads.some(t => t.id === state.currentThreadId)) state.currentThreadId = state.threads[0].id;
                saveThreads();
                renderHistoryDrawer();
                renderThreadView();
            };
        });
    }

    /* ===== Empty State & Inline-Token Message Bubble Rendering ===== */
    function renderThreadView() {
        const thread = currentThread();
        els.threadTitle.textContent = thread.title || '新对话';
        if (!thread.messages || !thread.messages.length) {
            els.messages.innerHTML = `
                <div class="sa-empty">
                    <div class="sa-empty-orb"></div>
                    <div class="sa-empty-title">让 创作Agent 辅助你的无限创意</div>
                    <div class="sa-starter-list">
                        <button type="button" class="sa-starter-item" data-starter="perceive">
                            <span class="sa-starter-left"><i data-lucide="git-fork"></i><span>感知画布开始创作</span></span>
                            <i data-lucide="arrow-right" class="sa-starter-arrow"></i>
                        </button>
                        <button type="button" class="sa-starter-item" data-starter="fusion">
                            <span class="sa-starter-left"><i data-lucide="layers"></i><span>多参考图融合与包装替换</span></span>
                            <i data-lucide="arrow-right" class="sa-starter-arrow"></i>
                        </button>
                        <button type="button" class="sa-starter-item" data-starter="reverse">
                            <span class="sa-starter-left"><i data-lucide="wand-sparkles"></i><span>反推选中节点生图提示词</span></span>
                            <i data-lucide="arrow-right" class="sa-starter-arrow"></i>
                        </button>
                        <button type="button" class="sa-starter-item" data-starter="storyboard">
                            <span class="sa-starter-left"><i data-lucide="clapperboard"></i><span>批量衍生多视角与场景方案</span></span>
                            <i data-lucide="arrow-right" class="sa-starter-arrow"></i>
                        </button>
                    </div>
                </div>
            `;
            els.messages.querySelectorAll('[data-starter]').forEach(btn => {
                btn.onclick = () => handleStarterAction(btn.dataset.starter);
            });
            if (window.lucide) lucide.createIcons({ nodes: [els.messages] });
            return;
        }

        els.messages.innerHTML = '';
        thread.messages.forEach(msg => {
            els.messages.appendChild(buildMessageDom(msg));
        });
        if (window.lucide) lucide.createIcons({ nodes: [els.messages] });
        scrollMessagesBottom();
    }

    function handleStarterAction(kind) {
        if (kind === 'perceive') {
            els.richInput.textContent = '请感知画布节点并告诉我有哪些推荐的创作方向（先不要生图）';
            syncSendButtonState();
            sendAgentMessage();
            return;
        }
        if (kind === 'fusion') {
            els.richInput.textContent = '保持 ';
            els.richInput.focus();
            saveAgentCaretRange();
            if (typeof toast === 'function') toast('现在依次点击画布上的主图与参考图节点，即可自动插入行内引用');
            return;
        }
        if (kind === 'reverse') {
            const selId = typeof selectedId !== 'undefined' ? selectedId : '';
            clearAgentRichInput();
            els.richInput.appendChild(document.createTextNode('请反推 '));
            if (selId) insertInlineTokenIntoAgentInput(selId, { focusInput: false });
            els.richInput.appendChild(document.createTextNode(' 的完整生图提示词（仅反推提示词，不要生图）'));
            syncSendButtonState();
            els.richInput.focus();
            return;
        }
        if (kind === 'storyboard') {
            els.richInput.textContent = '基于所选主体衍生 2 个不同景别与光影氛围的新生图节点：';
            syncSendButtonState();
            els.richInput.focus();
        }
    }

    function buildUserRichBubbleHtml(msg) {
        if (Array.isArray(msg.segments) && msg.segments.length) {
            return msg.segments.map(seg => {
                if (seg.type === 'token') {
                    return `<span class="sa-inline-token" data-locate-node="${escapeHtml(seg.baseNodeId || seg.refKey || '')}">${seg.thumb ? `<img src="${escapeHtml(seg.thumb)}" alt="">` : ''}<span class="sa-inline-token-label">${escapeHtml(seg.name || '节点')}</span></span>`;
                }
                return escapeHtml(seg.text || '');
            }).join('');
        }
        return escapeHtml(msg.content || '');
    }

    function buildMessageDom(msg) {
        const wrap = document.createElement('div');
        wrap.className = `sa-msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
        const bubble = document.createElement('div');
        bubble.className = 'sa-msg-bubble';

        if (msg.role === 'user') {
            const richDiv = document.createElement('div');
            richDiv.className = 'sa-msg-rich';
            richDiv.innerHTML = buildUserRichBubbleHtml(msg);
            richDiv.querySelectorAll('[data-locate-node]').forEach(tok => {
                tok.onclick = () => focusCanvasNodeById(tok.dataset.locateNode, true);
            });
            bubble.appendChild(richDiv);
            wrap.appendChild(bubble);

            const userActions = document.createElement('div');
            userActions.className = 'sa-msg-actions user';
            userActions.innerHTML = `
                <button type="button" class="sa-msg-act-btn" data-user-copy title="复制提问内容（粘贴回输入框自动保留节点胶囊）">
                    <i data-lucide="copy"></i>
                </button>
                <button type="button" class="sa-msg-act-btn" data-user-refill title="重新填入输入框编辑">
                    <i data-lucide="corner-up-left"></i>
                </button>
            `;
            const copyBtn = userActions.querySelector('[data-user-copy]');
            copyBtn.onclick = e => {
                e.stopPropagation();
                copyAgentContent(msg.content || '', {
                    segments: msg.segments,
                    buttonEl: copyBtn,
                    toastText: '已复制提问内容'
                });
            };
            const refillBtn = userActions.querySelector('[data-user-refill]');
            refillBtn.onclick = e => {
                e.stopPropagation();
                populateAgentInputFromMessage(msg);
                if (typeof toast === 'function') toast('已填入输入框，可继续编辑');
            };
            wrap.appendChild(userActions);
            if (window.lucide) lucide.createIcons({ nodes: [userActions] });
            return wrap;
        }

        const statusEl = document.createElement('div');
        statusEl.className = 'sa-msg-status';
        statusEl.hidden = !msg.error;
        if (msg.error) {
            statusEl.classList.add('error');
            statusEl.innerHTML = `<span class="sa-status-dot"></span><span>${escapeHtml(msg.error)}</span>`;
        }
        bubble.appendChild(statusEl);

        const reasoningWrap = document.createElement('details');
        reasoningWrap.className = 'sa-reasoning-box';
        reasoningWrap.hidden = !msg.reasoning;
        reasoningWrap.innerHTML = `<summary><i data-lucide="lightbulb"></i><span>思考过程</span><i data-lucide="chevron-down" class="sa-reasoning-chevron"></i></summary><div class="sa-reasoning-content">${escapeHtml(msg.reasoning || '')}</div>`;
        bubble.appendChild(reasoningWrap);

        const textEl = document.createElement('div');
        textEl.className = 'sa-msg-text';
        renderAgentFormattedText(textEl, msg.content || '');
        bubble.appendChild(textEl);

        const createdList = document.createElement('div');
        createdList.className = 'sa-created-list';
        if (Array.isArray(msg.createdTasks) && msg.createdTasks.length) {
            msg.createdTasks.forEach(ct => {
                createdList.appendChild(buildMinimalCreatedLine(ct));
            });
        }
        bubble.appendChild(createdList);

        const actionsBar = document.createElement('div');
        actionsBar.className = 'sa-msg-actions assistant';

        const syncActions = () => {
            const hasReplyText = Boolean((msg.content || '').trim());
            const taskPrompts = (msg.createdTasks || []).map(t => String(t.prompt || '').trim()).filter(Boolean);
            const hasTaskPrompts = taskPrompts.length > 0;
            if (!hasReplyText && !hasTaskPrompts && !msg.error) {
                actionsBar.hidden = true;
                actionsBar.innerHTML = '';
                return;
            }
            actionsBar.hidden = false;
            actionsBar.innerHTML = `
                <button type="button" class="sa-msg-act-btn" data-assist-copy title="复制回答内容">
                    <i data-lucide="copy"></i>
                </button>
                ${hasTaskPrompts ? `
                <button type="button" class="sa-msg-act-btn with-label" data-assist-copy-prompt title="一键复制生成的完整生图提示词">
                    <i data-lucide="sparkles"></i><span class="sa-act-label">复制提示词</span>
                </button>` : ''}
                <button type="button" class="sa-msg-act-btn" data-assist-retry title="按上一条提问重新生成方案">
                    <i data-lucide="rotate-cw"></i>
                </button>
            `;
            const copyReplyBtn = actionsBar.querySelector('[data-assist-copy]');
            if (copyReplyBtn) {
                copyReplyBtn.onclick = e => {
                    e.stopPropagation();
                    const fullCopy = [String(msg.content || '').trim(), ...(!msg.content && hasTaskPrompts ? taskPrompts : [])].filter(Boolean).join('\n\n');
                    copyAgentContent(fullCopy, { buttonEl: copyReplyBtn, toastText: '已复制回答内容' });
                };
            }
            const copyPromptBtn = actionsBar.querySelector('[data-assist-copy-prompt]');
            if (copyPromptBtn) {
                copyPromptBtn.onclick = e => {
                    e.stopPropagation();
                    copyAgentContent(taskPrompts.join('\n\n'), { buttonEl: copyPromptBtn, toastText: '已复制生图提示词' });
                };
            }
            const retryBtn = actionsBar.querySelector('[data-assist-retry]');
            if (retryBtn) {
                retryBtn.onclick = e => {
                    e.stopPropagation();
                    if (state.sending) return;
                    const msgs = currentThread().messages || [];
                    const idx = msgs.findIndex(item => item.id === msg.id);
                    const prevUser = idx > 0
                        ? msgs.slice(0, idx).reverse().find(item => item.role === 'user')
                        : [...msgs].reverse().find(item => item.role === 'user');
                    if (!prevUser) return;
                    populateAgentInputFromMessage(prevUser);
                    sendAgentMessage();
                };
            }
            if (window.lucide) lucide.createIcons({ nodes: [actionsBar] });
        };
        syncActions();

        wrap.appendChild(bubble);
        wrap.appendChild(actionsBar);
        wrap._parts = { bubble, statusEl, reasoningWrap, textEl, createdList, actionsBar, syncActions };
        return wrap;
    }

    function resolveCreatedTaskLiveState(ct) {
        const node = (typeof nodes !== 'undefined' && Array.isArray(nodes))
            ? nodes.find(n => n.id === ct?.targetNodeId)
            : null;
        if (!node) {
            return { state: 'deleted', thumb: '', title: ct?.title || '生图节点' };
        }
        const liveTitle = (typeof smartSemanticNodeTitle === 'function' ? smartSemanticNodeTitle(node) : node.title) || ct?.title || '生图节点';
        const isRunning = Boolean(
            node.running ||
            Number(node.pending || 0) > 0 ||
            (Array.isArray(node.pendingTasks) && node.pendingTasks.some(t => !t.failed)) ||
            (node.jimengPending && !(node.images || []).length)
        );
        const imgs = (node.images || []).filter(it => it?.url);
        let thumb = '';
        if (imgs.length) {
            const lastImg = imgs[imgs.length - 1];
            thumb = typeof smartMediaPreviewUrl === 'function' ? smartMediaPreviewUrl(lastImg, 256) : lastImg.url;
        }
        if (isRunning) return { state: 'generating', thumb, title: liveTitle };
        if (imgs.length > 0) return { state: 'done', thumb, title: liveTitle };
        return { state: 'idle', thumb: '', title: liveTitle };
    }

    function updateCreatedLineDom(line, ct) {
        if (!line || !ct) return;
        const live = resolveCreatedTaskLiveState(ct);
        const stateKey = `${live.state}|${live.title}|${live.thumb}`;
        if (line.dataset.liveStateKey === stateKey) return;
        line.dataset.liveStateKey = stateKey;

        line.className = 'sa-created-line' + (
            live.state === 'generating' ? ' is-generating' :
            live.state === 'done' ? ' is-done' :
            live.state === 'deleted' ? ' is-deleted' : ''
        );

        const modelSuffix = ct.modelLabel ? ` (${escapeHtml(ct.modelLabel)})` : '';
        const copyPromptChip = ct.prompt
            ? `<button type="button" class="sa-created-copy" data-copy-created-prompt title="复制该节点生图提示词"><i data-lucide="copy"></i></button>`
            : '';
        if (live.state === 'generating') {
            line.innerHTML = `
                <span class="sa-status-dot"></span>
                <span class="sa-created-line-title">正在生图中… · ${escapeHtml(live.title)}${modelSuffix}</span>
                ${copyPromptChip}
            `;
        } else if (live.state === 'done') {
            line.innerHTML = `
                ${live.thumb ? `<img class="sa-created-thumb" src="${escapeHtml(live.thumb)}" alt="">` : '<span class="sa-created-done-dot"></span>'}
                <span class="sa-created-line-title">生图已完成 · ${escapeHtml(live.title)}${modelSuffix}</span>
                ${copyPromptChip}
            `;
        } else if (live.state === 'deleted') {
            line.innerHTML = `
                <i data-lucide="image-off"></i>
                <span class="sa-created-line-title">节点已移除 · ${escapeHtml(live.title)}</span>
                ${copyPromptChip}
            `;
        } else {
            line.innerHTML = `
                <i data-lucide="image"></i>
                <span class="sa-created-line-title">图片节点已创建 · ${escapeHtml(live.title)}${modelSuffix}</span>
                ${copyPromptChip}
                <button type="button" class="sa-created-rerun" data-run-created>运行</button>
            `;
            const runBtn = line.querySelector('[data-run-created]');
            if (runBtn) {
                runBtn.onclick = e => {
                    e.stopPropagation();
                    const target = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === ct.targetNodeId);
                    if (!target) return;
                    executeAgentNodeGeneration(target, ct.prompt, target.runSettings || {}, ct.composerHtml, ct.promptRefs);
                };
            }
        }
        const copyTaskBtn = line.querySelector('[data-copy-created-prompt]');
        if (copyTaskBtn) {
            copyTaskBtn.onclick = e => {
                e.stopPropagation();
                copyAgentContent(ct.prompt || '', { buttonEl: copyTaskBtn, toastText: '已复制该节点提示词' });
            };
        }
        if (window.lucide) lucide.createIcons({ nodes: [line] });
    }

    function syncCreatedTaskLinesWithCanvas() {
        if (!els.messages) return;
        els.messages.querySelectorAll('.sa-created-line').forEach(line => {
            if (line._taskData) updateCreatedLineDom(line, line._taskData);
        });
    }

    function buildMinimalCreatedLine(ct) {
        const line = document.createElement('div');
        line.className = 'sa-created-line';
        line.title = '点击在画布中定位并查看该生图节点';
        line._taskData = ct;
        line.onclick = e => {
            if (e.target.closest('[data-run-created], [data-copy-created-prompt]')) return;
            focusCanvasNodeById(ct.targetNodeId, true);
        };
        updateCreatedLineDom(line, ct);
        return line;
    }

    function scrollMessagesBottom() {
        requestAnimationFrame(() => {
            if (els.messages) els.messages.scrollTop = els.messages.scrollHeight;
        });
    }

    /* ===== Client-Side Plan Parser (Used by /api/canvas-llm Fallback) ===== */
    function cleanPromptFences(text) {
        const s = String(text || '').trim();
        const m = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/);
        return m ? m[1].trim() : s;
    }

    function parseAgentPlanClientSide(rawText, candidateItems, userMessage) {
        const raw = String(rawText || '');
        const validIds = new Set((candidateItems || []).map(it => it.id));
        const indexToId = new Map();
        (candidateItems || []).forEach((it, idx) => {
            indexToId.set(it.index || (idx + 1), it.id);
            indexToId.set(idx + 1, it.id);
        });

        let visibleText = raw;
        let planJsonStr = '';
        const tagMatch = raw.match(/<agent_plan>\s*([\s\S]*?)\s*(?:<\/agent_plan>|$)/i);
        if (tagMatch) {
            visibleText = (raw.slice(0, tagMatch.index) + raw.slice(tagMatch.index + tagMatch[0].length)).trim();
            planJsonStr = tagMatch[1].trim();
        }

        const resolveSourceIds = (rawIds, promptText = '') => {
            const out = [];
            (rawIds || []).forEach(item => {
                const sid = String(item || '').trim();
                if (!sid) return;
                if (validIds.has(sid) && !out.includes(sid)) { out.push(sid); return; }
                const baseMatches = [...validIds].filter(vid => vid.split('#')[0] === sid);
                if (baseMatches.length === 1 && !out.includes(baseMatches[0])) { out.push(baseMatches[0]); return; }
                const numMatch = sid.match(/^(?:#|图片?\s*|节点\s*)?(\d+)$/);
                if (numMatch) {
                    const mapped = indexToId.get(Number(numMatch[1]));
                    if (mapped && validIds.has(mapped) && !out.includes(mapped)) out.push(mapped);
                }
            });
            if (!out.length && promptText && validIds.size) {
                const matches = [...promptText.matchAll(/(?:图片|图)\s*([1-9]\d?)/g)];
                matches.forEach(m => {
                    const mapped = indexToId.get(Number(m[1]));
                    if (mapped && validIds.has(mapped) && !out.includes(mapped)) out.push(mapped);
                });
            }
            return out;
        };

        if (planJsonStr) {
            const cleaned = cleanPromptFences(planJsonStr);
            const brace = cleaned.match(/\{[\s\S]*\}/);
            if (brace) {
                try {
                    const parsed = JSON.parse(brace[0]);
                    const action = String(parsed.action || '').trim();
                    const reply = String(parsed.reply || '').trim();
                    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : (parsed.prompt ? [parsed] : []);
                    const tasks = [];
                    rawTasks.slice(0, 4).forEach(t => {
                        const pVal = cleanPromptFences(t?.prompt || '');
                        if (!pVal) return;
                        const srcIds = resolveSourceIds(t.source_node_ids || t.node_ids || [], pVal);
                        const aspect = String(t.aspect_ratio || '').trim();
                        tasks.push({
                            title: String(t.title || '').trim().slice(0, 60),
                            source_node_ids: srcIds,
                            prompt: pVal,
                            aspect_ratio: LABEL_TO_RATIO_KEY[aspect] ? aspect : ''
                        });
                    });
                    if (action === 'create_generation_node' && tasks.length) {
                        return { visibleText, plan: { action: 'create_generation_node', reply, tasks } };
                    }
                    return { visibleText, plan: { action: 'chat', reply, tasks: [] } };
                } catch (_) {}
            }
        }

        const noGen = /不要生图|不生图|不要出图|仅反推|只反推|只要提示词|不要创建节点/.test(userMessage || '');
        if (!noGen) {
            const secMatch = visibleText.match(/【最终可用提示词】[\s\S]*?```[a-zA-Z0-9_-]*\s*\n([\s\S]+?)\n?```/);
            if (secMatch) {
                const extractedPrompt = secMatch[1].trim();
                const pinnedOnly = (candidateItems || []).filter(it => it.mentioned).map(it => it.id);
                const inferred = resolveSourceIds(pinnedOnly, extractedPrompt);
                return {
                    visibleText,
                    plan: {
                        action: 'create_generation_node',
                        reply: '已提取最终生图提示词并创建画布生图节点。',
                        tasks: [{ title: '', source_node_ids: inferred, prompt: extractedPrompt, aspect_ratio: '' }]
                    }
                };
            }
        }
        return { visibleText, plan: { action: 'chat', reply: '', tasks: [] } };
    }

    /* ===== Canvas Viewport Focus, Node Creation, Inline Token Composer Wiring & Parallel Multi-Model Execution ===== */
    function focusCanvasNodeById(nodeId, selectAndOpenComposer = false) {
        if (!nodeId || typeof nodes === 'undefined') return;
        const target = nodes.find(n => n.id === nodeId);
        if (!target || typeof nodeRect !== 'function' || typeof applyViewport !== 'function') return;
        const rect = nodeRect(target);
        const shellRect = shell?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
        let rightReserved = 0;
        if (state.open) {
            if (state.layoutMode === 'docked') {
                rightReserved = Math.min(state.dockWidth + 24, shellRect.width * 0.45);
            } else {
                const fr = state.floatRect || normalizeAgentFloatRect(null);
                if (fr.left > shellRect.width * 0.42) {
                    rightReserved = Math.min(shellRect.width - fr.left + 16, shellRect.width * 0.42);
                }
            }
        }
        const leftReserved = state.outlineOpen ? Math.min(348, shellRect.width * 0.32) : 0;
        const visibleCenterX = leftReserved + (shellRect.width - leftReserved - rightReserved) * 0.5;
        const visibleCenterY = shellRect.height * 0.38;

        viewport.x = Math.round(visibleCenterX - (rect.x + rect.width / 2) * viewport.scale);
        viewport.y = Math.round(visibleCenterY - (rect.y + rect.height / 2) * viewport.scale);
        applyViewport();

        if (selectAndOpenComposer) {
            selectedId = target.id;
            selectedIds = [target.id];
            selectedImage = { nodeId: '', index: -1 };
            lastComposerNodeId = '';
            if (typeof syncSelectionUi === 'function') syncSelectionUi();
            if (typeof updateComposer === 'function') updateComposer();
            syncLineageHighlight();
        }
    }

    function closestRatioKeyForDimensions(w, h) {
        if (!(w > 0 && h > 0)) return 'square';
        const target = w / h;
        let bestKey = 'square';
        let bestDiff = Infinity;
        const ratios = {
            square: 1,
            portrait: 2 / 3,
            landscape: 3 / 2,
            portrait43: 3 / 4,
            landscape43: 4 / 3,
            story: 9 / 16,
            wide: 16 / 9,
            ultrawide: 21 / 9
        };
        Object.entries(ratios).forEach(([key, val]) => {
            const diff = Math.abs(Math.log(target / val));
            if (diff < bestDiff) { bestDiff = diff; bestKey = key; }
        });
        return bestKey;
    }

    function buildNodeRunSettingsForTarget(task, sourceDetails, targetModelSpec) {
        const base = typeof cloneSmartSettings === 'function' ? cloneSmartSettings(settings) : {};
        const pid = targetModelSpec?.provider || state.imageProvider || base.provider_id || 'grsai';
        const mdl = targetModelSpec?.model || state.imageModel || base.model || '';

        let ratio = 'square';
        let resolution = '1k';
        let customWidth = '';
        let customHeight = '';
        let customSize = '';

        if (state.sizeMode === 'custom') {
            resolution = 'custom';
            ratio = '';
            customWidth = state.customW;
            customHeight = state.customH;
            customSize = `${state.customW}x${state.customH}`;
        } else if (state.sizeMode === 'preset') {
            ratio = state.ratioKey || 'square';
            resolution = state.resTier || '2k';
        } else {
            if (task?.aspect_ratio && LABEL_TO_RATIO_KEY[task.aspect_ratio]) {
                ratio = LABEL_TO_RATIO_KEY[task.aspect_ratio];
            } else if (sourceDetails?.length) {
                const dimItem = sourceDetails.find(d => d.width > 0 && d.height > 0);
                if (dimItem) ratio = closestRatioKeyForDimensions(dimItem.width, dimItem.height);
            }
            resolution = typeof defaultSmartApiResolution === 'function' ? defaultSmartApiResolution(mdl) : '1k';
        }

        if (pid === 'modelscope') {
            return {
                ...base,
                engine: 'modelscope',
                msgenModel: ['zimage', 'qwen_edit', 'klein_edit'].includes(mdl) ? mdl : 'klein_edit',
                msRatio: ratio || 'square',
                msResolution: resolution === '4k' ? '2k' : resolution,
                msCustomWidth: customWidth,
                msCustomHeight: customHeight,
                msCustomSize: customSize,
                count: 1
            };
        }

        return {
            ...base,
            engine: pid === 'volcengine' ? 'volcengine' : 'api',
            apiKind: 'image',
            provider_id: pid,
            model: mdl,
            ratio,
            resolution,
            customRatio: '',
            customWidth,
            customHeight,
            customSize,
            count: 1
        };
    }

    function computeNewGenNodePosition(sourceNodes, slotIndex) {
        const gapX = 120;
        const gapY = 44;
        let x = 0;
        let y = 0;

        if (sourceNodes.length && typeof nodeRect === 'function') {
            const rects = sourceNodes.map(n => nodeRect(n));
            const maxRight = Math.max(...rects.map(r => (Number(r.x) || 0) + (Number(r.width) || 280)));
            const minTop = Math.min(...rects.map(r => Number(r.y) || 0));
            x = Math.round(maxRight + gapX);
            y = Math.round(minTop + slotIndex * 360);
        } else {
            const shellRect = shell?.getBoundingClientRect() || { width: window.innerWidth, height: window.innerHeight };
            const rightClear = state.open
                ? (state.layoutMode === 'docked' ? (state.dockWidth + 24) : 430)
                : 40;
            const visibleW = Math.max(340, shellRect.width - rightClear);
            x = Math.round((visibleW * 0.45 - viewport.x) / viewport.scale - 150);
            y = Math.round((shellRect.height * 0.34 - viewport.y) / viewport.scale - 110 + slotIndex * 360);
        }

        if (typeof nodeRect === 'function' && Array.isArray(nodes)) {
            const nearby = nodes
                .map(n => nodeRect(n))
                .filter(r => Math.abs((Number(r.x) || 0) - x) < 300)
                .sort((a, b) => (Number(a.y) || 0) - (Number(b.y) || 0));
            for (const r of nearby) {
                const top = Number(r.y) || 0;
                const bottom = top + (Number(r.height) || 220);
                if (y + 220 > top && y < bottom + gapY) {
                    y = Math.round(bottom + gapY);
                }
            }
        }
        return { x, y };
    }

    async function executeAgentNodeGeneration(genNode, promptText, nodeRunSettings, richComposerHtml = '', promptRefs = []) {
        if (!genNode || !promptText) return;
        if (typeof smartNodeInFlight === 'function' && smartNodeInFlight(genNode)) return;

        const blockedSet = typeof blockedInputRefKeys === 'function' ? blockedInputRefKeys(genNode) : new Set();
        const rawRefs = (typeof defaultReferenceImagesFor === 'function'
            ? defaultReferenceImagesFor(genNode, true, null)
            : []).filter(img => {
                if (!blockedSet.size || typeof inputRefKey !== 'function') return true;
                return !blockedSet.has(inputRefKey(img));
            });

        const refs = rawRefs.map((img, index) => ({
            url: img.url,
            name: `图片 ${index + 1}`,
            kind: img.kind || 'image',
            nodeId: img.nodeId || '',
            imageIndex: img.imageIndex ?? 0,
            asset_uris: img.asset_uris || {},
            role: `image_${index + 1}`
        }));

        // Build final model prompt with explicit reference map header when references exist
        const modelPrompt = refs.length
            ? `参考图对应关系：\n${refs.map((r, i) => `图片 ${i + 1}（图${i + 1}）：第 ${i + 1} 张输入参考图`).join('\n')}\n\n生成要求：\n${promptText}`
            : promptText;

        const meta = {
            prompt: modelPrompt,
            displayPrompt: promptText,
            promptHtml: richComposerHtml || genNode.promptDraftHtml || escapeHtml(promptText),
            promptText: genNode.promptDraftText || promptText,
            promptRefs: (promptRefs && promptRefs.length) ? promptRefs : refs,
            inputRefs: refs,
            sourceNodeId: genNode.id,
            settings: JSON.parse(JSON.stringify(nodeRunSettings)),
            createdAt: Date.now()
        };

        const prevGlobalSettings = typeof cloneSmartSettings === 'function' ? cloneSmartSettings(settings) : null;
        settings = { ...settings, ...(typeof cloneSmartSettings === 'function' ? cloneSmartSettings(nodeRunSettings) : nodeRunSettings) };
        const runLog = typeof smartRunSnapshot === 'function'
            ? smartRunSnapshot(genNode, promptText, refs, 'image')
            : null;
        if (prevGlobalSettings) settings = prevGlobalSettings;

        const runLogStart = Date.now();
        genNode.pending = 1;
        genNode.runStartedAt = runLogStart;
        genNode.runTimerHidden = false;
        delete genNode.runFinishedAt;
        delete genNode.runElapsedMs;

        const sizeStr = typeof sizeForRun === 'function' ? sizeForRun(nodeRunSettings) : '1024x1024';
        const parsedDim = typeof parseSizeValue === 'function' ? parseSizeValue(sizeStr) : null;
        if (typeof displayBoxFromNaturalSize === 'function' && parsedDim) {
            const box = displayBoxFromNaturalSize(parsedDim);
            genNode.w = box.w;
            genNode.h = box.h;
        }
        if (typeof attachRunMeta === 'function') attachRunMeta(genNode, meta);
        if (typeof render === 'function') render();

        try {
            if (nodeRunSettings.engine === 'modelscope' && typeof runModelscopeGeneration === 'function') {
                genNode.running = true;
                if (typeof render === 'function') render();
                const outImages = await runModelscopeGeneration(modelPrompt, refs, nodeRunSettings);
                if (!outImages?.length) throw new Error('ModelScope 未返回生成图片');
                if (typeof finalizePendingNode === 'function') finalizePendingNode(genNode, outImages, meta);
                if (runLog && typeof addSmartGenerationLog === 'function') {
                    addSmartGenerationLog({ run: runLog, outputs: outImages, runMs: Date.now() - runLogStart });
                }
                if (typeof scheduleSave === 'function') scheduleSave();
                return;
            }

            const out = await runApiGeneration(modelPrompt, refs, nodeRunSettings);
            const taskIds = Array.isArray(out?.taskIds) ? out.taskIds : [];
            if (!taskIds.length) throw new Error('未获取到生图任务 ID');
            genNode.pendingTasks = taskIds.map(taskId => ({
                taskId,
                kind: 'image',
                providerId: out.providerId,
                model: out.model
            }));
            genNode.pending = taskIds.length;
            genNode.running = false;
            if (typeof render === 'function') render();
            if (typeof scheduleSave === 'function') scheduleSave();
            if (typeof saveCanvas === 'function') await saveCanvas();
            if (typeof resumeSmartPendingNode === 'function') {
                await resumeSmartPendingNode(genNode, { run: runLog, runLogStart });
            }
            if (genNode.jimengPending || (typeof smartRecoverableImageTask === 'function' && smartRecoverableImageTask(genNode))) {
                if (typeof scheduleSave === 'function') scheduleSave();
                return;
            }
            if (runLog && (genNode.images || []).length && typeof addSmartGenerationLog === 'function') {
                addSmartGenerationLog({ run: runLog, outputs: genNode.images || [], runMs: Date.now() - runLogStart });
            }
            if (typeof scheduleSave === 'function') scheduleSave();
        } catch (err) {
            if (typeof handleJimengPendingSignal === 'function' && handleJimengPendingSignal(genNode, err)) return;
            genNode.pending = 0;
            genNode.running = false;
            if (runLog && typeof addSmartGenerationLog === 'function') {
                addSmartGenerationLog({ run: runLog, outputs: [], runMs: Date.now() - runLogStart, error: err.message || String(err) });
            }
            if (typeof toast === 'function') toast((err.message || '生图失败').slice(0, 160));
        } finally {
            genNode.running = false;
            if (typeof render === 'function') render();
        }
    }

    function applyPlanTasksToCanvas(plan) {
        if (!plan || plan.action !== 'create_generation_node' || !Array.isArray(plan.tasks) || !plan.tasks.length) {
            return [];
        }
        if (typeof savePromptDraftForCurrent === 'function') savePromptDraftForCurrent();
        if (typeof pushUndo === 'function') pushUndo();

        const targetModels = activeImageTargetModels();
        const isMultiCompare = targetModels.length > 1;
        const createdRecords = [];
        let firstCreatedNode = null;
        let slotCursor = 0;

        plan.tasks.forEach(task => {
            const sourceDetails = (task.source_node_ids || [])
                .map((rk, i) => resolveRefItemDetails(rk, i + 1))
                .filter(Boolean);

            const uniqueBaseNodes = [];
            const allowedSubIndicesByNode = new Map();
            sourceDetails.forEach(detail => {
                const nodeObj = (typeof nodes !== 'undefined' && nodes || []).find(n => n.id === detail.baseNodeId);
                if (!nodeObj) return;
                if (!uniqueBaseNodes.includes(nodeObj)) uniqueBaseNodes.push(nodeObj);
                if (detail.subImageIndex >= 0) {
                    if (!allowedSubIndicesByNode.has(nodeObj.id)) allowedSubIndicesByNode.set(nodeObj.id, new Set());
                    allowedSubIndicesByNode.get(nodeObj.id).add(detail.subImageIndex);
                }
            });

            // Build inline `.mention-image-token` HTML for the generated node's own Composer!
            const composerTokenData = buildGeneratedNodeComposerTokens(task.prompt, sourceDetails);

            targetModels.forEach(targetModelSpec => {
                const pos = computeNewGenNodePosition(uniqueBaseNodes, slotCursor++);
                const genNode = createNode(pos.x, pos.y, [], { skipUndo: true, select: false });
                const mdlShort = shortModelLabel(targetModelSpec.model);
                const baseTaskTitle = task.title || (typeof smartSemanticNodeTitle === 'function' ? smartSemanticNodeTitle({ runPrompt: task.prompt }) : '生图节点');
                genNode.title = isMultiCompare ? `${baseTaskTitle} · ${mdlShort}` : baseTaskTitle;

                uniqueBaseNodes.forEach(src => {
                    connectInputNode(src.id, genNode.id);
                });

                const blockedKeys = [];
                allowedSubIndicesByNode.forEach((allowedSet, nodeId) => {
                    const owner = uniqueBaseNodes.find(n => n.id === nodeId);
                    (owner?.images || []).forEach((img, subIdx) => {
                        if (img?.url && !allowedSet.has(subIdx)) blockedKeys.push(`${nodeId}|${subIdx}`);
                    });
                });
                if (blockedKeys.length) genNode.blockedInputRefs = blockedKeys;

                const nodeRunSettings = buildNodeRunSettingsForTarget(task, sourceDetails, targetModelSpec);
                genNode.runSettings = typeof settingsForStorage === 'function'
                    ? settingsForStorage(nodeRunSettings)
                    : nodeRunSettings;

                // Write inline thumbnail tokens directly into genNode's Composer draft & runPromptRefs!
                genNode.promptDraftHtml = composerTokenData.html;
                genNode.promptDraftText = composerTokenData.plainText;
                genNode.runPrompt = composerTokenData.plainText;
                genNode.runPromptRefs = composerTokenData.promptRefs;
                genNode.promptDraftTouched = true;

                if (!firstCreatedNode) firstCreatedNode = genNode;

                createdRecords.push({
                    targetNodeId: genNode.id,
                    title: genNode.title,
                    prompt: task.prompt,
                    composerHtml: composerTokenData.html,
                    promptRefs: composerTokenData.promptRefs,
                    autoRan: Boolean(state.autoRun),
                    modelLabel: mdlShort,
                    _nodeRef: genNode,
                    _runSettings: nodeRunSettings
                });
            });
        });

        if (firstCreatedNode) {
            selectedId = firstCreatedNode.id;
            selectedIds = [firstCreatedNode.id];
            selectedImage = { nodeId: '', index: -1 };
            lastComposerNodeId = '';
            if (typeof render === 'function') render();
            if (typeof updateComposer === 'function') updateComposer();
            if (typeof renderDynamicParams === 'function') renderDynamicParams();
            focusCanvasNodeById(firstCreatedNode.id, true);
            if (typeof scheduleSave === 'function') scheduleSave();
        }

        if (state.autoRun) {
            createdRecords.forEach(rec => {
                executeAgentNodeGeneration(rec._nodeRef, rec.prompt, rec._runSettings, rec.composerHtml, rec.promptRefs);
            });
        }

        return createdRecords.map(({ _nodeRef, _runSettings, ...clean }) => clean);
    }

    /* ===== Seamless Fallback to /api/canvas-llm (Zero-Restart Support) ===== */
    function messageReferencesCanvasVisuals(text) {
        const s = String(text || '').toLowerCase();
        return /图\s*[1-9]|节点|这张|那张|上面|画布里|画布上|参考|基于|改|换|替换|融合|微调|反推|识别|分析图/.test(s);
    }

    async function runViaCanvasLlmFallback(payload, candidateItems, signal, setStage, onDelta) {
        setStage('正在结合系统提示词分析节点…');
        const images = [];
        const seenImages = new Set();
        const videos = [];
        const nodeLines = [];
        const hasExplicitFocus = candidateItems.some(n => n.mentioned || n.selected || n.is_upstream_origin);
        const allowVision = hasExplicitFocus || messageReferencesCanvasVisuals(payload.message);
        const maxImgs = hasExplicitFocus ? 8 : 4;

        if (candidateItems.length) {
            nodeLines.push(`以下是当前画布的 ${candidateItems.length} 个候选节点（请根据目标挑选需要连线的 node_id）：`);
            candidateItems.forEach((node, idx) => {
                const dispIdx = node.index || (idx + 1);
                const statusLabel = node.mentioned
                    ? '用户在输入句中直接引用'
                    : (node.is_upstream_origin ? `衍生出节点 ${node.origin_for_id} 的上游原始参考源节点` : (node.selected ? '画布已选中' : '画布已有节点'));
                const sizePart = node.width > 0 && node.height > 0 ? ` | 尺寸: ${node.width}x${node.height}` : '';
                let line = `【画布节点 #${dispIdx}（图片 ${dispIdx}） | node_id: ${node.id} | 类型: ${node.type} | 标题: ${node.title} | 状态: ${statusLabel}${sizePart}】`;
                if (node.text) line += `\n节点文本/提示词内容：${node.text}`;
                nodeLines.push(line);

                if (allowVision && images.length < maxImgs) {
                    (node.image_urls || []).slice(0, 2).forEach(u => {
                        if (u && !seenImages.has(u) && images.length < maxImgs) {
                            seenImages.add(u);
                            images.push(u);
                        }
                    });
                }
                if (allowVision && videos.length < 2) {
                    (node.video_urls || []).slice(0, 1).forEach(v => {
                        if (v && videos.length < 2) videos.push(v);
                    });
                }
            });
        } else {
            nodeLines.push('当前未引用画布参考节点（若用户需要文生图，请规划 source_node_ids: [] 的新建生图节点）。');
        }
        nodeLines.push(`\n用户的当前指令：\n${payload.message}\n\n请简洁说明方案，并在最末尾附上 <agent_plan>...</agent_plan>。`);

        const baseSys = payload.system_prompt || '你是智能无限画布的资深 AI 图像创作与编辑提示词专家。';
        const reqBody = JSON.stringify({
            message: nodeLines.join('\n\n'),
            messages: payload.history || [],
            images,
            videos,
            model: payload.model,
            provider: payload.provider,
            ms_model: payload.ms_model,
            system_prompt: baseSys + CLIENT_AGENT_PROTOCOL,
            skill_ids: payload.skill_ids || []
        });

        const streamRes = await fetch('/api/canvas-llm/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: reqBody
        });

        if (streamRes.status !== 404) {
            if (!streamRes.ok) {
                const rawErr = await streamRes.text().catch(() => '');
                throw new Error(rawErr || `LLM 流式请求失败 (${streamRes.status})`);
            }
            const reader = streamRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullRaw = '';
            const emitVisible = () => {
                if (typeof onDelta !== 'function') return;
                const openIdx = fullRaw.toLowerCase().indexOf('<agent_plan>');
                onDelta(openIdx >= 0 ? fullRaw.slice(0, openIdx).trimEnd() : fullRaw);
            };
            const processSse = block => {
                const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                if (!data || data === '[DONE]') return;
                const evt = JSON.parse(data);
                if (evt.type === 'delta' && evt.delta) {
                    fullRaw += evt.delta;
                    emitVisible();
                } else if (evt.type === 'done' && typeof evt.text === 'string') {
                    fullRaw = evt.text;
                } else if (evt.type === 'error') {
                    throw new Error(evt.detail || 'LLM 流式执行失败');
                }
            };
            for (;;) {
                const { value, done } = await reader.read();
                buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                let sep;
                while ((sep = /\r?\n\r?\n/.exec(buffer))) {
                    const block = buffer.slice(0, sep.index);
                    buffer = buffer.slice(sep.index + sep[0].length);
                    processSse(block);
                }
                if (done) {
                    if (buffer.trim()) processSse(buffer);
                    break;
                }
            }
            return parseAgentPlanClientSide(fullRaw.trim(), candidateItems, payload.message);
        }

        const res = await fetch('/api/canvas-llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: reqBody
        });

        if (!res.ok) {
            const rawErr = await res.text().catch(() => '');
            let cleanErr = rawErr;
            try {
                const parsedErr = JSON.parse(rawErr);
                cleanErr = parsedErr?.detail || parsedErr?.error?.message || parsedErr?.message || rawErr;
            } catch (_) {}
            throw new Error(cleanErr || `LLM 请求失败 (${res.status})`);
        }

        const data = await res.json();
        return parseAgentPlanClientSide(String(data.text || '').trim(), candidateItems, payload.message);
    }

    /* ===== Send & Stream Agent Conversation ===== */
    async function sendAgentMessage() {
        if (state.sending) return;
        const extracted = extractRichInputPayload();
        if (!extracted.messageForLlm) return;

        ensureValidModels();
        closeAllAgentPopovers();

        // Build full candidate node list:
        // 1) Inline-token referenced nodes in exact sentence order
        // 2) Upstream original source reference nodes of any referenced generated node (Optimization #2!)
        // 3) If no inline tokens were inserted, fallback to currently selected node or recent canvas nodes
        let candidateItems = [];
        if (extracted.referencedItems.length > 0) {
            const directIds = extracted.referencedItems.map(it => it.id);
            const upstreamOrigins = collectUpstreamOriginDetails(extracted.referencedItems, directIds)
                .map((orig, i) => ({ ...orig, index: extracted.referencedItems.length + i + 1 }));
            candidateItems = [...extracted.referencedItems, ...upstreamOrigins];
        } else {
            const selIds = typeof selectedNodeIds === 'function' ? selectedNodeIds() : [];
            const selectedDetails = selIds.map((id, i) => {
                const d = resolveRefItemDetails(id, i + 1);
                return d ? { ...d, selected: true, mentioned: false } : null;
            }).filter(Boolean);

            if (selectedDetails.length) {
                const upstreamOrigins = collectUpstreamOriginDetails(selectedDetails, selectedDetails.map(d => d.id))
                    .map((orig, i) => ({ ...orig, index: selectedDetails.length + i + 1 }));
                candidateItems = [...selectedDetails, ...upstreamOrigins];
            } else {
                const needBgVision = messageReferencesCanvasVisuals(extracted.messageForLlm);
                candidateItems = sortedAllCanvasNodes()
                    .map((n, i) => resolveRefItemDetails(n.id, i + 1))
                    .filter(it => it && (it.image_urls.length || it.text))
                    .slice(-8)
                    .map((it, i) => ({
                        ...it,
                        image_urls: needBgVision ? it.image_urls : [],
                        video_urls: needBgVision ? it.video_urls : [],
                        index: i + 1,
                        selected: false,
                        mentioned: false
                    }));
            }
        }

        const thread = currentThread();
        if (!thread.messages.length || thread.title === '新对话') {
            thread.title = (extracted.plainDisplay || '新对话').replace(/\s+/g, ' ').slice(0, 20) || '新对话';
            els.threadTitle.textContent = thread.title;
        }

        els.messages.querySelector('.sa-empty')?.remove();

        const historyForApi = thread.messages.slice(-12).map(m => {
            let content = String(m.llmContent || m.content || '');
            if (Array.isArray(m.createdTasks) && m.createdTasks.length) {
                const summary = m.createdTasks.map(ct => `[已在画布新建生图节点 ${ct.targetNodeId}（${ct.title}）]`).join('\n');
                content = [content, summary].filter(Boolean).join('\n');
            }
            return { role: m.role, content };
        });

        const userMsg = {
            id: 'm_' + Date.now(),
            role: 'user',
            content: extracted.plainDisplay,
            llmContent: extracted.messageForLlm,
            segments: extracted.segments,
            createdAt: Date.now()
        };
        thread.messages.push(userMsg);
        thread.updatedAt = Date.now();
        els.messages.appendChild(buildMessageDom(userMsg));

        const assistantRecord = {
            id: 'm_' + (Date.now() + 1),
            role: 'assistant',
            content: '',
            reasoning: '',
            createdTasks: [],
            createdAt: Date.now()
        };
        const assistantDom = buildMessageDom(assistantRecord);
        els.messages.appendChild(assistantDom);

        clearAgentRichInput();

        state.sending = true;
        els.orbWrap.classList.add('is-busy');
        syncSendButtonState();
        scrollMessagesBottom();

        const startedAt = Date.now();
        let stageText = '正在思考创作方案…';
        const renderLiveStatus = () => {
            const sec = Math.floor((Date.now() - startedAt) / 1000);
            assistantDom._parts.statusEl.hidden = false;
            assistantDom._parts.statusEl.classList.remove('error');
            assistantDom._parts.statusEl.innerHTML = `<span class="sa-status-dot"></span><span>${escapeHtml(stageText)} · ${sec}s</span>`;
        };
        renderLiveStatus();
        const statusTimer = setInterval(renderLiveStatus, 1000);

        const controller = new AbortController();
        state.abortController = controller;

        const cProviders = availableChatProviders();
        const safeProvider = state.chatProvider || cProviders[0]?.id || 'custom-api';
        const safeModel = state.chatModel || cProviders.find(p => p.id === safeProvider)?.models?.[0] || '';

        const payload = {
            canvas_id: (typeof canvas !== 'undefined' && canvas?.id) || (typeof canvasId !== 'undefined' && canvasId) || '',
            message: extracted.messageForLlm,
            system_prompt: effectiveAgentSystemPrompt(),
            skill_ids: effectiveSkillIds(),
            provider: safeProvider,
            model: safeModel,
            ms_model: safeProvider === 'modelscope' ? safeModel : '',
            history: historyForApi,
            canvas_nodes: candidateItems.map(({ thumb, baseNodeId, subImageIndex, kindLabel, primaryUrl, primaryKind, ...rest }) => rest)
        };

        try {
            let receivedPlan = null;

            const handleFallbackDelta = textSoFar => {
                assistantRecord.content = textSoFar;
                renderAgentFormattedText(assistantDom._parts.textEl, textSoFar);
                scrollMessagesBottom();
            };

            if (state.serverStreamSupported === false) {
                const fb = await runViaCanvasLlmFallback(payload, candidateItems, controller.signal, msg => {
                    stageText = msg;
                    renderLiveStatus();
                }, handleFallbackDelta);
                assistantRecord.content = fb.visibleText;
                renderAgentFormattedText(assistantDom._parts.textEl, fb.visibleText);
                receivedPlan = fb.plan;
            } else {
                const res = await fetch('/api/smart-canvas/agent/stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify(payload)
                });

                if (res.status === 404) {
                    state.serverStreamSupported = false;
                    const fb = await runViaCanvasLlmFallback(payload, candidateItems, controller.signal, msg => {
                        stageText = msg;
                        renderLiveStatus();
                    }, handleFallbackDelta);
                    assistantRecord.content = fb.visibleText;
                    renderAgentFormattedText(assistantDom._parts.textEl, fb.visibleText);
                    receivedPlan = fb.plan;
                } else {
                    if (!res.ok) {
                        const rawErr = await res.text().catch(() => '');
                        let cleanErr = rawErr;
                        try {
                            const parsedErr = JSON.parse(rawErr);
                            cleanErr = parsedErr?.detail || parsedErr?.error?.message || parsedErr?.message || rawErr;
                        } catch (_) {}
                        throw new Error(cleanErr || `请求失败 (${res.status})`);
                    }
                    state.serverStreamSupported = true;
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    const processFrame = frame => {
                        const dataLine = frame
                            .split(/\r?\n/)
                            .filter(l => l.startsWith('data:'))
                            .map(l => l.slice(5).trimStart())
                            .join('\n');
                        if (!dataLine || dataLine === '[DONE]') return;
                        const evt = JSON.parse(dataLine);
                        if (evt.type === 'status') {
                            stageText = evt.message || '正在处理…';
                            renderLiveStatus();
                        } else if (evt.type === 'reasoning') {
                            const wasHidden = assistantDom._parts.reasoningWrap.hidden;
                            assistantRecord.reasoning += evt.delta || '';
                            assistantDom._parts.reasoningWrap.hidden = false;
                            assistantDom._parts.reasoningWrap.querySelector('.sa-reasoning-content').textContent = assistantRecord.reasoning;
                            if (wasHidden && window.lucide) lucide.createIcons({ nodes: [assistantDom._parts.reasoningWrap] });
                            scrollMessagesBottom();
                        } else if (evt.type === 'delta') {
                            assistantRecord.content += evt.delta || '';
                            renderAgentFormattedText(assistantDom._parts.textEl, assistantRecord.content);
                            scrollMessagesBottom();
                        } else if (evt.type === 'plan') {
                            receivedPlan = evt.plan;
                        } else if (evt.type === 'done') {
                            if (typeof evt.text === 'string') {
                                assistantRecord.content = evt.text;
                                renderAgentFormattedText(assistantDom._parts.textEl, evt.text);
                            }
                            if (evt.plan) receivedPlan = evt.plan;
                        } else if (evt.type === 'error') {
                            throw new Error(evt.detail || 'Agent 执行出错');
                        }
                    };

                    while (true) {
                        const { value, done } = await reader.read();
                        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                        let sep;
                        while ((sep = /\r?\n\r?\n/.exec(buffer))) {
                            const frame = buffer.slice(0, sep.index);
                            buffer = buffer.slice(sep.index + sep[0].length);
                            processFrame(frame);
                        }
                        if (done) {
                            if (buffer.trim()) processFrame(buffer);
                            break;
                        }
                    }
                }
            }

            clearInterval(statusTimer);
            assistantDom._parts.statusEl.innerHTML = '';
            assistantDom._parts.statusEl.classList.remove('error');
            assistantDom._parts.statusEl.hidden = true;

            if (receivedPlan && receivedPlan.action === 'create_generation_node') {
                const createdTasks = applyPlanTasksToCanvas(receivedPlan);
                assistantRecord.createdTasks = createdTasks;
                createdTasks.forEach(ct => {
                    assistantDom._parts.createdList.appendChild(buildMinimalCreatedLine(ct));
                });
                if (window.lucide) lucide.createIcons({ nodes: [assistantDom._parts.createdList] });
                if (!assistantRecord.content && receivedPlan.reply) {
                    assistantRecord.content = receivedPlan.reply;
                    renderAgentFormattedText(assistantDom._parts.textEl, receivedPlan.reply);
                }
            }

            thread.messages.push(assistantRecord);
            assistantDom._parts.syncActions?.();
            thread.updatedAt = Date.now();
            saveThreads();
            scrollMessagesBottom();
        } catch (err) {
            clearInterval(statusTimer);
            const aborted = err?.name === 'AbortError';
            const msgText = aborted ? '已手动停止' : (err?.message || '请求失败');
            assistantRecord.error = msgText;
            assistantDom._parts.statusEl.hidden = false;
            assistantDom._parts.statusEl.classList.add('error');
            assistantDom._parts.statusEl.innerHTML = `<span class="sa-status-dot"></span><span>${escapeHtml(msgText)}</span>`;
            if (assistantRecord.content || !aborted) {
                thread.messages.push(assistantRecord);
                assistantDom._parts.syncActions?.();
                saveThreads();
            }
        } finally {
            clearInterval(statusTimer);
            state.sending = false;
            state.abortController = null;
            els.orbWrap.classList.remove('is-busy');
            syncSendButtonState();
            updateOutlineBadgeCount();
        }
    }

    function refreshAllAgentUI() {
        loadThreads();
        ensureValidModels();
        renderPresetStrip();
        updateToolbarLabels();
        renderThreadView();
        updateOutlineBadgeCount();
        syncLineageHighlight();
    }

    /* ===== Hook into Smart Canvas Lifecycle & Selection Updates ===== */
    function hookCanvasLifecycle() {
        if (typeof render === 'function' && !render._saWrapped) {
            const origRender = render;
            const wrappedRender = function (...args) {
                const res = origRender.apply(this, args);
                updateOutlineBadgeCount();
                syncLineageHighlight();
                syncCreatedTaskLinesWithCanvas();
                return res;
            };
            wrappedRender._saWrapped = true;
            render = wrappedRender;
        }

        if (typeof syncSelectionUi === 'function' && !syncSelectionUi._saWrapped) {
            const origSync = syncSelectionUi;
            const wrappedSync = function (...args) {
                const res = origSync.apply(this, args);
                syncLineageHighlight();
                if (state.outlineOpen) renderOutlineList();
                return res;
            };
            wrappedSync._saWrapped = true;
            syncSelectionUi = wrappedSync;
        }

        if (typeof refreshConnectionLayer === 'function' && !refreshConnectionLayer._saWrapped) {
            const origRefreshConn = refreshConnectionLayer;
            const wrappedRefreshConn = function (...args) {
                const res = origRefreshConn.apply(this, args);
                syncLineageHighlight();
                return res;
            };
            wrappedRefreshConn._saWrapped = true;
            refreshConnectionLayer = wrappedRefreshConn;
        }
    }

    async function fetchExtraConfig() {
        try {
            const [cfg] = await Promise.all([
                fetch('/api/config').then(r => r.ok ? r.json() : {}).catch(() => ({})),
                window.LLMSkills?.load?.().catch(() => [])
            ]);
            if (Array.isArray(cfg?.ms_chat_models)) {
                state.msChatModels = cfg.ms_chat_models;
            }
        } catch (_) {}
    }

    const prevOnload = window.onload;
    window.onload = async function (...args) {
        if (typeof prevOnload === 'function') {
            await prevOnload.apply(this, args);
        }
        await fetchExtraConfig();
        hookCanvasLifecycle();
        mountAgentUI();
    };
})();
