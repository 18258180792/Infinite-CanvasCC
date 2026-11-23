const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const smartSrc = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
const canvasSrc = fs.readFileSync(path.join(__dirname, '../static/js/canvas.js'), 'utf8');

function extractDecl(src, kindAndName){
    const start = src.indexOf(kindAndName);
    assert.notEqual(start, -1, 'Missing declaration: ' + kindAndName);
    const rest = src.slice(start);
    const nextMatch = rest.slice(1).search(/\n(?:(?:async )?function |class |const smartTaskWsSnapshots)/);
    return nextMatch < 0 ? rest : rest.slice(0, nextMatch + 1);
}

function smartHarness(extra={}){
    let renderCalls = 0;
    let saveDelays = [];
    const context = vm.createContext({
        Map,
        Set,
        URL,
        Math,
        Number,
        Array,
        String,
        Boolean,
        Date,
        Promise,
        setTimeout,
        clearTimeout,
        nodes: [],
        smartTaskWsSnapshots: new Map(),
        smartTaskWsWakeups: new Map(),
        activeSmartTaskPolls: new Map(),
        selectedImage: {nodeId:'', index:-1},
        MEDIA_GROUP_MAX_VISIBLE_ROWS: 3,
        imageForDisplay: img => img,
        mediaKindForItem: () => 'image',
        thumbMediaHtml: img => `<img src="${img.url}">`,
        singleMediaHtml: img => `<img src="${img.url}">`,
        imageNameBadgeHtml: () => '',
        imageResolutionBadgeHtml: () => '',
        escapeHtml: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escapeAttr: s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
        tr: k => k,
        nowMs: () => 1000,
        render: () => { renderCalls += 1; },
        scheduleSave: delay => { saveDelays.push(delay); },
        completeSmartNodeWithImages: (node, images) => ({...node, images, pending:0, queued:false, running:false, pendingTasks:undefined}),
        ...extra,
    });
    const decls = [
        'function smartPendingTasks(',
        'class JimengPendingSignal',
        'class ImageTaskRecoverSignal',
        'function extractUpstreamTaskId(',
        'function smartNodeInFlight(',
        'function smartNodeHasDisplayResult(',
        'function smartNodeHasCompletedResult(',
        'function mergeSmartImageLists(',
        'function mergeSmartNode(',
        'function shortUpstreamTaskId(',
        'function smartPendingCellInnerHtml(',
        'function smartPendingStatusStripHtml(',
        'function nodeBodyHtml(',
        'function smartRecoverableImageTask(',
        'function imageTaskRecoverBodyHtml(',
        'function findSmartPendingTaskById(',
        'function syncSmartPendingTaskProgress(',
        'function handleCanvasTaskUpdatedMessage(',
        'async function pollSmartCanvasTask(',
    ];
    for(const decl of decls){
        vm.runInContext(extractDecl(smartSrc, decl), context);
    }
    return {
        context,
        stats: () => ({renderCalls, saveDelays}),
    };
}

test('syncSmartPendingTaskProgress binds recoverTaskId and stage immediately on running snapshot', () => {
    const node = {
        id: 'node-1',
        type: 'smart-image',
        pending: 1,
        images: [],
        pendingTasks: [{taskId: 'local-1', kind: 'image', providerId: 'soonstudio', model: 'seedream-v5-pro'}],
    };
    const {context, stats} = smartHarness({nodes: [node]});
    context.handleCanvasTaskUpdatedMessage({
        task_id: 'local-1',
        task: {
            id: 'local-1',
            status: 'running',
            stage: 'polling',
            upstream_task_id: 'upstream-abcdef123456',
            provider_id: 'soonstudio',
            model: 'seedream-v5-pro',
        },
    });
    assert.equal(node.pendingTasks[0].recoverTaskId, 'upstream-abcdef123456');
    assert.equal(node.pendingTasks[0].stage, 'polling');
    assert.equal(stats().renderCalls, 1);
    assert.deepEqual(stats().saveDelays, [150]);
});

test('pollSmartCanvasTask converts HTTP 404 after server restart into ImageTaskRecoverSignal when recoverTaskId is bound', async () => {
    const node = {
        id: 'node-1',
        type: 'smart-image',
        pending: 1,
        images: [],
        pendingTasks: [{
            taskId: 'local-404',
            kind: 'image',
            providerId: 'grsai',
            recoverTaskId: 'grsai-task-7788',
            stage: 'polling',
        }],
    };
    const {context} = smartHarness({
        nodes: [node],
        fetch: async () => ({ok: false, status: 404, text: async () => 'not found'}),
    });
    await assert.rejects(
        () => context.pollSmartCanvasTask('local-404'),
        err => Boolean(err && err.imageTaskRecover && err.recoverTaskId === 'grsai-task-7788' && err.autoQuery === true)
    );
});

test('smartNodeHasCompletedResult and mergeSmartNode keep remaining pendingTasks when 1 of N images is done', () => {
    const localNode = {
        id: 'node-multi',
        type: 'smart-image',
        pending: 1,
        runFinishedAt: 500,
        images: [{url: '/assets/output/done-1.png'}],
        pendingTasks: [{taskId: 'local-2', kind: 'image', providerId: 'soonstudio', recoverTaskId: 'up-2', failed: true}],
    };
    const {context} = smartHarness({
        nodes: [localNode],
        cleanHistoryImages: imgs => imgs || [],
    });
    assert.equal(context.smartNodeHasCompletedResult(localNode), false);
    const merged = context.mergeSmartNode(localNode, {
        ...localNode,
        images: [{url: '/assets/output/done-1.png'}],
    });
    assert.equal(merged.pendingTasks.length, 1);
    assert.equal(merged.pendingTasks[0].recoverTaskId, 'up-2');
});

test('nodeBodyHtml renders accepted task id pill while running and recovery strip even when imgs.length >= 1', () => {
    const runningNode = {
        id: 'n-run',
        type: 'smart-image',
        pending: 1,
        images: [],
        pendingTasks: [{taskId: 'local-run', recoverTaskId: '1234567890abcdef', stage: 'polling'}],
    };
    const partialNode = {
        id: 'n-partial',
        type: 'smart-image',
        pending: 1,
        images: [{url: '/assets/output/one.png'}],
        pendingTasks: [{taskId: 'local-fail', recoverTaskId: 'upstream-recover-99', failed: true}],
    };
    const {context} = smartHarness({nodes: [runningNode, partialNode]});
    const runningHtml = context.nodeBodyHtml(runningNode, {width: 260, height: 180, cols: 1, thumb: 96});
    assert.ok(runningHtml.includes('已受理'));
    assert.ok(runningHtml.includes('data-copy-task-id="1234567890abcdef"'));

    const partialHtml = context.nodeBodyHtml(partialNode, {width: 260, height: 180, cols: 1, thumb: 96});
    assert.ok(partialHtml.includes('smart-pending-strip'));
    assert.ok(partialHtml.includes('data-image-task-query="n-partial"'));
    assert.ok(partialHtml.includes('data-task-id="local-fail"'));
    assert.ok(partialHtml.includes('data-copy-task-id="upstream-recover-99"'));
});

test('canvas.js failCanvasImageTask preserves recoverable pending slot via pre-bound pending.recoverTaskId', () => {
    const pending = {
        id: 'p-1',
        canvasTaskId: 'canvas_img_1',
        canvasTaskType: 'online-image',
        providerId: 'soonstudio',
        recoverTaskId: 'soon-prebound-555',
        startedAt: 100,
        run: {node: {id: 'gen-1'}},
    };
    const out = {id: 'out-1', type: 'output', _pending: [pending]};
    const gen = {id: 'gen-1'};
    const ctx = vm.createContext({
        nodes: [out, gen],
        nowMs: () => 500,
        tr: k => k,
        addGenerationLog: () => {},
        refreshRunNodes: () => {},
        scheduleSave: () => {},
    });
    for(const decl of ['function findPendingTask(', 'function extractUpstreamTaskId(', 'function providerIdForPending(', 'function failCanvasImageTask(']){
        vm.runInContext(extractDecl(canvasSrc, decl), ctx);
    }
    ctx.failCanvasImageTask('canvas_img_1', '后端已重启，任务状态已丢失', {});
    assert.equal(out._pending.length, 1);
    assert.equal(out._pending[0].failed, true);
    assert.equal(out._pending[0].recoverTaskId, 'soon-prebound-555');
});
