const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function functionSource(name){
    const pattern = new RegExp('(?:async )?function ' + name + '\\(');
    const start = source.search(pattern);
    assert.notEqual(start, -1, 'Missing production function: ' + name);
    const rest = source.slice(start);
    const end = rest.slice(1).search(/\n(?:async )?function /);
    return end < 0 ? rest : rest.slice(0, end + 1);
}
function context(extra={}){
    return vm.createContext({URL, window:{location:{href:'http://localhost:3000/smart-canvas'}}, ...extra});
}
function load(ctx, names){
    for(const name of names) vm.runInContext(functionSource(name), ctx);
}

test('named image downloads keep the project name instead of the remote UUID', () => {
    const ctx = context({mediaKindForItem:() => 'image'});
    load(ctx, ['safeExportFileName', 'fileNameFromUrl', 'extensionForMediaItem', 'downloadNameForMediaItem']);
    const name = '\u9879\u76eeA_\u6d77\u62a5\u6587\u6848_20261010_01.png';
    assert.equal(ctx.downloadNameForMediaItem({url:'https://cdn.example.test/uuid.png', name}), name);
    assert.equal(ctx.downloadNameForMediaItem({url:'/assets/output/uuid.png', name}), name);
});

test('legacy media retain URL names and extension inference when explicit names are absent', () => {
    const ctx = context({mediaKindForItem:() => 'image'});
    load(ctx, ['safeExportFileName', 'fileNameFromUrl', 'extensionForMediaItem', 'downloadNameForMediaItem']);
    assert.equal(ctx.downloadNameForMediaItem({url:'https://cdn.example.test/original.webp?signature=1'}), 'original.webp');
    assert.equal(ctx.downloadNameForMediaItem({url:'https://cdn.example.test/result.jpg', name:'Project:cover'}), 'Project_cover.jpg');
});

test('API generation submits the captured canvas ID for every image task', async () => {
    const requests = [];
    const ctx = context({
        canvas:{id:'project-current'}, canvasId:'project-url', settings:{}, API_RATIO_VALUES:{},
        SMART_REFERENCE_IMAGE_MAX:8, sizeForRun:() => '1024x1024', imageRefsOnly:refs => refs,
        fetch:async (url, options) => {
            requests.push({url, payload:JSON.parse(options.body)});
            return {ok:true, json:async () => ({task_id:'task-' + requests.length})};
        },
    });
    load(ctx, ['runApiGeneration']);
    await ctx.runApiGeneration('cover', [], {provider_id:'comfly', model:'seedream-v5-pro', count:2});
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.payload.canvas_id === 'project-current'));
    ctx.canvas = null;
    await ctx.runApiGeneration('cover', [], {provider_id:'comfly', model:'seedream-v5-pro'});
    assert.equal(requests[2].payload.canvas_id, 'project-url');
});

test('legacy unnamed downloads use the real project name without changing source data', () => {
    const projectName = '空气奶白猫砂';
    const oldName = '未命名项目_cover_20261010-143025_01_ab12cd.png';
    const ctx = context({canvas:{project_name:projectName, title:'Canvas title'}, mediaKindForItem:() => 'image'});
    load(ctx, ['safeExportFileName', 'fileNameFromUrl', 'extensionForMediaItem', 'downloadNameForMediaItem']);
    const item = {url:'https://cdn.example.test/uuid.png', name:oldName};
    assert.equal(ctx.downloadNameForMediaItem(item), projectName + '_cover_20261010-143025_01_ab12cd.png');
    assert.equal(item.name, oldName);
    assert.equal(item.url, 'https://cdn.example.test/uuid.png');
    assert.equal(ctx.downloadNameForMediaItem({url:'/assets/output/' + encodeURIComponent(oldName)}), projectName + '_cover_20261010-143025_01_ab12cd.png');
    assert.equal(ctx.downloadNameForMediaItem({...item, name:'OtherProject_cover.png'}), 'OtherProject_cover.png');
});

test('legacy unnamed downloads never substitute a canvas title for a project name', () => {
    const oldName = '未命名项目_cover.png';
    const ctx = context({canvas:{title:'Unrelated canvas title'}, mediaKindForItem:() => 'image'});
    load(ctx, ['safeExportFileName', 'fileNameFromUrl', 'extensionForMediaItem', 'downloadNameForMediaItem']);
    assert.equal(ctx.downloadNameForMediaItem({url:'/assets/output/uuid.png', name:oldName}), oldName);
});

test('legacy project prefix cleaning matches generated image filename components', () => {
    const oldName = '未命名项目_cover.png';
    const ctx = context({canvas:{project_name:' ._ Air:/\ncat _.'}, mediaKindForItem:() => 'image'});
    load(ctx, ['safeExportFileName', 'fileNameFromUrl', 'extensionForMediaItem', 'downloadNameForMediaItem']);
    assert.equal(ctx.downloadNameForMediaItem({name:oldName}), 'Air cat_cover.png');
});

test('upscale submits the same project context without changing the reference image name', async () => {
    let payload;
    const item = {url:'/assets/output/input.png', name:'Project_cover.png'};
    const target = {id:'target', images:[]};
    const ctx = context({
        canvas:{id:'project-current'}, canvasId:'project-url', settings:{jimengUpscaleRes:'2k'},
        JIMENG_UPSCALE_RESOLUTIONS:['2k'], liveSmartNode:node => node,
        imageForDisplay:image => image, mediaKindForItem:() => 'image', jimengImageProviderId:() => 'jimeng',
        pushUndo:() => {}, nodeRect:() => ({x:0,y:0,width:100,height:100}),
        createImageNodeAt:() => target, nowMs:() => 0, render:() => {}, scheduleSave:() => {},
        saveCanvas:async () => {}, resumeSmartPendingNode:async () => {},
        toast:message => { throw new Error(message); }, tr:value => value,
        fetch:async (url, options) => {
            payload = JSON.parse(options.body);
            return {ok:true, json:async () => ({task_id:'task-upscale'})};
        },
    });
    load(ctx, ['runJimengUpscale']);
    await ctx.runJimengUpscale({id:'source', images:[item]}, 0);
    assert.equal(payload.canvas_id, 'project-current');
    assert.equal(payload.reference_images[0].name, item.name);
    assert.equal(payload.operation, 'upscale');
});
