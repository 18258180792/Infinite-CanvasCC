const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const canvasListSrc = fs.readFileSync(path.join(__dirname, '../static/js/canvas-list.js'), 'utf8');
const assetMgrSrc = fs.readFileSync(path.join(__dirname, '../static/js/asset-manager.js'), 'utf8');
const smartCanvasSrc = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas-agent.js'), 'utf8');
const agentCss = fs.readFileSync(path.join(__dirname, '../static/css/smart-canvas-agent.css'), 'utf8');
const unifiedCss = fs.readFileSync(path.join(__dirname, '../static/css/studio-unified.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
const smartCanvasHtml = fs.readFileSync(path.join(__dirname, '../static/smart-canvas.html'), 'utf8');

test('classic canvas entry points are removed from canvas-list and asset-manager', () => {
    assert.ok(!canvasListSrc.includes('data-kind="classic"'), 'canvas-list should not render classic toggle');
    assert.ok(!canvasListSrc.includes('/static/canvas.html?id='), 'canvas-list should always open smart-canvas.html');
    assert.ok(!assetMgrSrc.includes('/static/canvas.html?id='), 'asset-manager should always open smart-canvas.html');
});

test('smart-canvas.html mounts LibTV agent stylesheet and script with cache busters', () => {
    assert.ok(smartCanvasHtml.includes('/static/css/smart-canvas-agent.css?v='));
    assert.ok(smartCanvasHtml.includes('/static/js/smart-canvas.js?v='));
    assert.ok(smartCanvasHtml.includes('/static/js/smart-canvas-agent.js?v='));
    assert.ok(canvasListSrc.includes('SMART_CANVAS_ENTRY_VERSION'), 'canvas-list must bust stale HTML cache on old projects');
    assert.ok(!canvasListSrc.includes('v=2026.11.20.1'), 'hardcoded old v=2026.11.20.1 must be removed');
});

test('inline-token rich input & generated node native mention-image-token wiring exist', () => {
    assert.ok(agentSrc.includes("GPT_CHAT_SETTINGS_KEY = 'gpt_chat_settings_v1'"));
    assert.ok(agentSrc.includes('id="saRichInput"'));
    assert.ok(!agentSrc.includes('id="saRefStrip"'), 'top separate reference strip should be removed');
    assert.ok(agentSrc.includes('insertInlineTokenIntoAgentInput'));
    assert.ok(agentSrc.includes('extractRichInputPayload'));
    assert.ok(agentSrc.includes('buildGeneratedNodeComposerTokens'));
    assert.ok(agentSrc.includes('genNode.promptDraftHtml = composerTokenData.html'));
    assert.ok(agentSrc.includes('genNode.runPromptRefs = composerTokenData.promptRefs'));
    assert.ok(agentSrc.includes('bindCanvasInteractions'));
    assert.ok(agentSrc.includes('runViaCanvasLlmFallback'));
    assert.ok(agentSrc.includes('/api/canvas-llm'));
});

test('all 5 canvas optimizations are implemented across JS and CSS', () => {
    // 1. Semantic node naming + Outline & Cmd+F search + Double-click rename
    assert.ok(smartCanvasSrc.includes('function smartSemanticNodeTitle(node)'));
    assert.ok(smartCanvasSrc.includes('data-rename-node='));
    assert.ok(agentSrc.includes("outlinePanel.id = 'saOutlinePanel'"));
    assert.ok(agentSrc.includes('startInlineNodeRename'));

    // 2. Upstream origin reference inheritance
    assert.ok(agentSrc.includes('function collectUpstreamOriginDetails('));
    assert.ok(agentSrc.includes('is_upstream_origin: true'));

    // 3. Recipe lineage highlight
    assert.ok(agentSrc.includes('function syncLineageHighlight()'));
    assert.ok(agentCss.includes('.world.sa-lineage-mode'));

    // 4. Starred final deliverables + one-click ZIP export
    assert.ok(smartCanvasSrc.includes('data-star-node='));
    assert.ok(agentSrc.includes('function downloadAllStarredNodesZip()'));
    assert.ok(agentSrc.includes('function buildSimpleZipBlob('));

    // 5. Multi-model parallel comparison
    assert.ok(agentSrc.includes('function activeImageTargetModels()'));
    assert.ok(agentSrc.includes('id="saCompareToggleBtn"'));

    // 6. Streaming status hides cleanly & created-node line tracks live generation state
    assert.ok(agentCss.includes('.sa-msg-status[hidden]'));
    assert.ok(agentSrc.includes("assistantDom._parts.statusEl.innerHTML = ''"));
    assert.ok(agentSrc.includes('function syncCreatedTaskLinesWithCanvas()'));

    // 7. Rich Copy & Assistant Card Copy + LibTV Unified Studio UI
    assert.ok(agentSrc.includes('async function copyAgentContent('));
    assert.ok(agentSrc.includes('data-user-copy'));
    assert.ok(agentSrc.includes('data-assist-copy'));
    assert.ok(agentSrc.includes('data-assist-copy-prompt'));
    assert.ok(agentSrc.includes('data-copy-created-prompt'));
    assert.ok(smartCanvasHtml.includes('id="promptCopyBtn"'));
    assert.ok(smartCanvasHtml.includes('/static/css/studio-unified.css'));
    assert.ok(indexHtml.includes('/static/css/studio-unified.css'));
    assert.ok(unifiedCss.includes('--lib-bg-root: #0e0f12'));
});

test('smartSemanticNodeTitle and buildGeneratedNodeComposerTokens produce expected semantic titles and inline tokens', () => {
    const titleStart = smartCanvasSrc.indexOf('const GENERIC_SMART_NODE_TITLES =');
    const titleEnd = smartCanvasSrc.indexOf('function render(){', titleStart);
    assert.ok(titleStart > 0 && titleEnd > titleStart);

    const tokenFnStart = agentSrc.indexOf('function buildGeneratedNodeComposerTokens(');
    const tokenFnEnd = agentSrc.indexOf('/* ===== Direct Canvas Node Click', tokenFnStart);
    assert.ok(tokenFnStart > 0 && tokenFnEnd > tokenFnStart);

    const sandbox = {
        tr: k => k,
        escapeHtml: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        mentionTokenHtml: ref => `<span class="mention-image-token" contenteditable="false" data-node-id="${ref.nodeId}"><span>${ref.name}</span></span>`
    };
    vm.createContext(sandbox);
    vm.runInContext(smartCanvasSrc.slice(titleStart, titleEnd) + '\n' + agentSrc.slice(tokenFnStart, tokenFnEnd), sandbox);

    // Generic 'Image' node with clipboard filename -> readable timestamp title
    assert.equal(
        sandbox.smartSemanticNodeTitle({
            title: 'Image',
            images: [{ name: 'clipboard_2026-11-16_15-26 (1).png', url: '/outputs/a.png' }]
        }),
        '剪贴板图 15:26(1)'
    );

    // Generic 'Image' node with SKU filename -> readable product name
    assert.equal(
        sandbox.smartSemanticNodeTitle({
            title: 'Image',
            images: [{ name: 'SKU4合一主图_800.png', url: '/outputs/b.png' }]
        }),
        'SKU4合一主图_800'
    );

    // Generated node with runPrompt -> concise prompt summary
    assert.equal(
        sandbox.smartSemanticNodeTitle({
            title: 'Image',
            runPrompt: '@图片 1 保持瑞梦迪猫砂包装立体构图并改为浅蓝反光背景',
            images: [{ name: 'output-1.png', url: '/outputs/c.png' }]
        }),
        '保持瑞梦迪猫砂包装立体构图并改为'
    );

    // Custom renamed node preserves custom title
    assert.equal(
        sandbox.smartSemanticNodeTitle({
            title: '豆腐猫砂定稿A',
            customTitle: true,
            runPrompt: '任意提示词'
        }),
        '豆腐猫砂定稿A'
    );

    // Legacy base64-migrated image names in old canvases fall back cleanly instead of showing base64 gibberish
    assert.equal(
        sandbox.smartSemanticNodeTitle({
            title: '上传节点',
            images: [{ name: 'QZdOCVP533gAAAABJRU5ErkJggg==', url: '/assets/output/canvas_media_e8e52950e5a7.png' }]
        }),
        '图片素材'
    );

    // Generated node Composer inline token conversion for 图片 1 / 图片 2
    const tokRes = sandbox.buildGeneratedNodeComposerTokens(
        '高端商业产品场景图：替换掉参考场景 图片 2 中的产品，包装设计严格沿用 图片 1 的白底绿字。',
        [
            { baseNodeId: 'node_pkg', subImageIndex: -1, primaryUrl: '/img/pkg.png', primaryKind: 'image' },
            { baseNodeId: 'node_scene', subImageIndex: -1, primaryUrl: '/img/scene.png', primaryKind: 'image' }
        ]
    );
    assert.equal(tokRes.promptRefs.length, 2);
    assert.ok(tokRes.html.includes('data-node-id="node_scene"'));
    assert.ok(tokRes.html.includes('data-node-id="node_pkg"'));
    assert.ok(tokRes.plainText.includes('@图片 2'));
    assert.ok(tokRes.plainText.includes('@图片 1'));
});

test('API Settings removes deprecated notice and supports smart relay & official presets', () => {
    const apiHtml = fs.readFileSync(path.join(__dirname, '../static/api-settings.html'), 'utf8');
    const apiJs = fs.readFileSync(path.join(__dirname, '../static/js/api-settings.js'), 'utf8');

    // Deprecated DX-OS banner is completely removed
    assert.ok(!apiHtml.includes('此项目已停更'));
    assert.ok(!apiHtml.includes('dx-os.com'));
    assert.ok(apiHtml.includes('id="quickConnectCard"'));
    assert.ok(apiHtml.includes('id="qcSmartPasteInput"'));
    assert.ok(apiHtml.includes('id="qcPaneOfficial"'));

    // Extract URL normalizer, paste parser, and smart model curator into isolated VM
    const qcStart = apiJs.indexOf('const OFFICIAL_API_PRESETS =');
    const qcEnd = apiJs.indexOf('function setQuickStatus(');
    const curateStart = apiJs.indexOf('function smartCurateModelSet(');
    const curateEnd = apiJs.indexOf('function smartCuratePickerModels(');
    assert.ok(qcStart > 0 && qcEnd > qcStart);
    assert.ok(curateStart > 0 && curateEnd > curateStart);

    const mockEls = {
        qcRelayUrlInput: { value: '', dataset: {} },
        qcRelayKeyInput: { value: '', dataset: {} },
        qcRelayNameInput: { value: '', dataset: {} }
    };
    const sandbox = vm.createContext({
        URL,
        document: {
            getElementById: id => mockEls[id] || null,
            querySelectorAll: () => []
        }
    });
    vm.runInContext(
        apiJs.slice(qcStart, qcEnd) +
        '\n' +
        apiJs.slice(curateStart, curateEnd) +
        '\nthis.__presets = OFFICIAL_API_PRESETS;',
        sandbox
    );

    assert.ok(Array.isArray(sandbox.__presets) && sandbox.__presets.length >= 8);

    // Auto-normalizes messy relay URLs
    assert.equal(
        sandbox.normalizeSmartApiBaseUrl('api.myrelay.top/v1/chat/completions'),
        'https://api.myrelay.top/v1'
    );
    assert.equal(
        sandbox.normalizeSmartApiBaseUrl('https://relay.example.org/'),
        'https://relay.example.org/v1'
    );
    assert.equal(
        sandbox.normalizeSmartApiBaseUrl('https://generativelanguage.googleapis.com/', 'gemini'),
        'https://generativelanguage.googleapis.com'
    );
    assert.equal(
        sandbox.normalizeSmartApiBaseUrl('https://ark.cn-beijing.volces.com', 'volcengine'),
        'https://ark.cn-beijing.volces.com/api/v3'
    );

    // Smart paste extracts URL + Key + friendly name from messy block
    sandbox.handleSmartRelayPaste('接口地址：https://api.abc-relay.com/v1/images/generations ，密钥 Key: sk-AbCdEfGh1234567890xyz 请妥善保管');
    assert.equal(mockEls.qcRelayUrlInput.value, 'https://api.abc-relay.com/v1');
    assert.equal(mockEls.qcRelayKeyInput.value, 'sk-AbCdEfGh1234567890xyz');
    assert.equal(mockEls.qcRelayNameInput.value, 'ABC-RELAY 中转');

    // Smart model curation filters noise & picks mainstream models when relay has >24 models
    const noisyUpstream = Array.from({ length: 30 }, (_, i) => `legacy-model-${i}`).concat([
        'text-embedding-3-large',
        'whisper-1',
        'gpt-image-1',
        'doubao-seedream-3-0-t2i',
        'gpt-4o',
        'deepseek-chat',
        'doubao-seedance-1-0-pro'
    ]);
    const curated = sandbox.smartCurateModelSet(noisyUpstream, {
        image: new Set(['gpt-image-1', 'doubao-seedream-3-0-t2i']),
        chat: new Set(['gpt-4o', 'deepseek-chat']),
        video: new Set(['doubao-seedance-1-0-pro'])
    });
    assert.deepEqual(Array.from(curated.image), ['gpt-image-1', 'doubao-seedream-3-0-t2i']);
    assert.deepEqual(Array.from(curated.chat), ['gpt-4o', 'deepseek-chat']);
    assert.deepEqual(Array.from(curated.video), ['doubao-seedance-1-0-pro']);
});
