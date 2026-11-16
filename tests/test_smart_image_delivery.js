const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/smart-canvas.js'), 'utf8');
function functionSource(name){
    const start = source.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'Missing production function: ' + name);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end < 0 ? undefined : end);
}
function harness(){
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const context = vm.createContext({
        URL,
        window: {location: {origin:'http://localhost:3000', href:'http://localhost:3000/smart-canvas'}},
        setTimeout(callback, delay){
            const id = nextId++;
            timers.set(id, {callback, at:now + delay});
            return id;
        },
        clearTimeout(id){ timers.delete(id); },
        smartViewportWantsHighRes: () => true,
        smartImageNearViewport: () => true,
        smartNodeElementsForHighResSync: root => [root],
        smartSelectedHighResLoaded: new Set(),
        smartSelectedHighResTimer: 0,
        smartSelectedHighResSeq: 0,
        selectedNodeIds: () => [],
        smartImageEditorIsOpen: () => false,
        SMART_SELECTED_HIGH_RES_DELAY: 200,
    });
    for(const name of ['smartOriginalMediaUrl', 'fileNameFromUrl', 'outputUrlLooksVideo',
        'proxiedMediaUrl', 'displayMediaUrl', 'smartMediaPreviewUrl', 'bindImageProxyFallback',
        'syncSmartSelectedImageResolution']){
        vm.runInContext(functionSource(name), context);
    }
    return {
        context,
        timers,
        tick(milliseconds){
            const until = now + milliseconds;
            for(;;){
                const pending = [...timers.entries()].filter(([,timer]) => timer.at <= until)
                    .sort((a,b) => a[1].at - b[1].at)[0];
                if(!pending) break;
                now = pending[1].at;
                timers.delete(pending[0]);
                pending[1].callback();
            }
            now = until;
        },
    };
}
function fakeImage(url){
    let src = url;
    const listeners = new Map();
    const image = {
        dataset:{originalSrc:url, previewSrc:url},
        isConnected:true,
        complete:false,
        naturalWidth:0,
        writes:[],
        get src(){ return src; },
        set src(value){ src = value; image.writes.push(value); image.complete = false; },
        getAttribute(name){ return name === 'src' ? src : null; },
        removeAttribute(name){ if(name === 'src') src = ''; },
        addEventListener(name, listener){
            if(!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(listener);
        },
        removeEventListener(name, listener){
            listeners.set(name, (listeners.get(name) || []).filter(item => item !== listener));
        },
        emit(name){ for(const listener of listeners.get(name) || []) listener(); },
    };
    return image;
}
const remote = 'https://cdn.example.test/result.png';

test('remote image starts direct; remote video remains proxied; local preview is unchanged', () => {
    const {context} = harness();
    assert.equal(context.smartMediaPreviewUrl(remote), remote);
    assert.equal(context.smartMediaPreviewUrl({url:remote}), remote);
    const video = 'https://cdn.example.test/result.mp4';
    assert.equal(context.smartMediaPreviewUrl(video), context.proxiedMediaUrl(video));
    assert.equal(context.smartMediaPreviewUrl('/assets/output/result.png', 512),
        '/api/media-preview?w=512&url=%2Fassets%2Foutput%2Fresult.png');
});

test('direct image gets five seconds before switching to proxy', () => {
    const h = harness();
    const image = fakeImage(remote);
    image.dataset.selectedHighResTarget = remote;
    h.context.bindImageProxyFallback(image, remote);
    h.tick(4999);
    assert.equal(image.src, remote);
    h.tick(1);
    assert.equal(image.src, h.context.proxiedMediaUrl(remote));
    assert.equal(image.dataset.previewSrc, image.src);
    assert.equal(image.dataset.proxyFallbackTried, '1');
    assert.equal(image.dataset.selectedHighResTarget, undefined);
});

test('direct load error immediately switches to proxy and cancels direct timeout', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.emit('error');
    assert.equal(image.src, h.context.proxiedMediaUrl(remote));
    assert.equal(h.timers.size, 1);
    h.tick(5000);
    assert.equal(image.writes.length, 1);
});

test('proxy errors retry at increasing delays, deduplicate pending retries and stop after three', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.emit('error');
    for(const delay of [1500, 3000, 4500]){
        const before = image.writes.length;
        image.emit('error');
        image.emit('error');
        assert.equal(h.timers.size, 1);
        h.tick(delay - 1);
        assert.equal(image.writes.length, before);
        h.tick(1);
        assert.equal(image.writes.length, before + 1);
        assert.match(image.src, /&_image_retry=/);
        assert.equal(image.dataset.previewSrc, h.context.proxiedMediaUrl(remote));
    }
    image.emit('error');
    assert.equal(h.timers.size, 0);
    assert.equal(image.writes.length, 4);
    assert.equal(image.dataset.imageDeliveryState, 'failed');
    assert.equal(image.alt, '加载失败');
});

test('successful direct load clears the fallback timer', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.complete = true;
    image.naturalWidth = 1024;
    image.emit('load');
    assert.equal(h.timers.size, 0);
    h.tick(10000);
    assert.equal(image.writes.length, 0);
});

test('successful proxy load clears a pending retry', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.emit('error');
    image.emit('error');
    assert.equal(h.timers.size, 1);
    image.complete = true;
    image.naturalWidth = 1024;
    image.emit('load');
    assert.equal(h.timers.size, 0);
    h.tick(10000);
    assert.equal(image.writes.length, 1);
});

test('already complete successful images do not schedule fallback', () => {
    const h = harness();
    const image = fakeImage(remote);
    image.complete = true;
    image.naturalWidth = 1024;
    h.context.bindImageProxyFallback(image, remote);
    assert.equal(h.timers.size, 0);
    assert.equal(image.writes.length, 0);
});

test('already complete failed images recover immediately when listeners were attached late', () => {
    const h = harness();
    const image = fakeImage(remote);
    image.complete = true;
    h.context.bindImageProxyFallback(image, remote);
    assert.equal(image.src, h.context.proxiedMediaUrl(remote));
    assert.equal(h.timers.size, 1);
    h.tick(5000);
    assert.equal(image.writes.length, 1);
    assert.equal(h.timers.size, 1);
});

test('local images are not bound or proxied', () => {
    const h = harness();
    const image = fakeImage('/assets/output/result.png');
    h.context.bindImageProxyFallback(image, image.src);
    image.emit('error');
    h.tick(10000);
    assert.equal(image.dataset.proxyFallbackBound, undefined);
    assert.equal(h.timers.size, 0);
    assert.equal(image.writes.length, 0);
});

test('binding twice does not duplicate fallback timers', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    h.context.bindImageProxyFallback(image, remote);
    assert.equal(h.timers.size, 1);
});

test('detached images are not mutated by direct fallback or delayed retries', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.isConnected = false;
    h.tick(5000);
    assert.equal(image.writes.length, 0);
    const second = fakeImage(remote);
    h.context.bindImageProxyFallback(second, remote);
    second.emit('error');
    second.emit('error');
    second.isConnected = false;
    h.tick(1500);
    assert.equal(second.writes.length, 1);
});

test('high resolution sync preserves a proxy fallback image and ignores video previews', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.emit('error');
    h.context.smartSelectedHighResLoaded.add(h.context.displayMediaUrl(remote));
    const video = fakeImage('https://cdn.example.test/result.mp4');
    video.dataset.previewKind = 'video';
    const root = {querySelectorAll: () => [image, video]};
    h.context.syncSmartSelectedImageResolution(root);
    assert.equal(image.writes.length, 1);
    assert.equal(image.dataset.selectedHighResTarget, undefined);
    assert.equal(video.writes.length, 0);
    assert.equal(h.timers.size, 1);
});

test('high resolution sync retains the direct source for remote images', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.smartSelectedHighResLoaded.add(remote);
    h.context.syncSmartSelectedImageResolution({querySelectorAll: () => [image]});
    assert.equal(image.dataset.selectedHighResTarget, remote);
    assert.equal(image.src, remote);
    assert.equal(image.writes.length, 0);
    assert.equal(h.timers.size, 0);
});

test('cleared retry state allows another bounded retry after a successful load', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    image.emit('error');
    image.emit('error');
    image.emit('load');
    assert.equal(h.timers.size, 0);
    image.emit('error');
    assert.equal(h.timers.size, 1);
    h.tick(3000);
    assert.equal(image.writes.length, 2);
});

test('hung proxy requests expire and exhaust three bounded retries visibly', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    h.tick(5000);
    for(const delay of [1500, 3000, 4500]){
        const before = image.writes.length;
        h.tick(20000);
        assert.equal(image.writes.length, before);
        h.tick(delay);
        assert.equal(image.writes.length, before + 1);
    }
    h.tick(20000);
    assert.equal(h.timers.size, 0);
    assert.equal(image.writes.length, 4);
    assert.equal(image.src, '');
    assert.equal(image.dataset.imageDeliveryState, 'failed');
    assert.match(image.title, /重新打开生成日志/);
});

test('successful proxy load clears its deadline', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    h.tick(5000);
    image.emit('load');
    h.tick(100000);
    assert.equal(image.writes.length, 1);
    assert.equal(h.timers.size, 0);
});

test('detached hung proxy stops without additional retries', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    h.tick(5000);
    image.isConnected = false;
    h.tick(100000);
    assert.equal(image.writes.length, 1);
    assert.equal(h.timers.size, 0);
});

test('cleanup removes old listeners and deadlines before lightbox reuse', () => {
    const h = harness();
    const image = fakeImage(remote);
    h.context.bindImageProxyFallback(image, remote);
    h.tick(5000);
    image.smartImageDeliveryCleanup();
    image.emit('error');
    h.tick(100000);
    assert.equal(image.writes.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(image.dataset.proxyFallbackBound, undefined);
});
