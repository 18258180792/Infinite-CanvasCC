(function(){
    let skills = [];
    let loading = null;

    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }

    async function load(force=false){
        if(loading && !force) return loading;
        loading = fetch('/api/llm-skills').then(async response => {
            if(!response.ok) throw new Error((await response.json()).detail || '加载 Skills 失败');
            const data = await response.json();
            skills = Array.isArray(data.skills) ? data.skills : [];
            return skills;
        }).finally(() => { loading = null; });
        return loading;
    }

    function refreshSelect(select, selectedIds=[]){
        if(!select) return;
        const selected = new Set((selectedIds || []).map(String));
        select.innerHTML = skills.length
            ? skills.map(skill => `<option value="${escapeHtml(skill.id)}" ${selected.has(String(skill.id)) ? 'selected' : ''}>${escapeHtml(skill.name || skill.id)}</option>`).join('')
            : '<option disabled>暂无 Skill，请先新增</option>';
    }

    function removeModal(){
        document.getElementById('llmSkillManagerModal')?.remove();
    }

    function openManager({selectedIds=[], onChange}={}){
        load().then(() => {
            removeModal();
            let selected = new Set((selectedIds || []).map(String));
            let activeId = skills[0]?.id || '';
            const modal = document.createElement('div');
            modal.id = 'llmSkillManagerModal';
            modal.className = 'llm-skill-modal';
            modal.innerHTML = `<div class="llm-skill-dialog" role="dialog" aria-modal="true">
                <div class="llm-skill-head"><strong>LLM Skills</strong><button type="button" data-close title="关闭">×</button></div>
                <input type="file" data-import-input webkitdirectory directory multiple hidden>
                <div class="llm-skill-layout">
                    <section class="llm-skill-list-pane">
                        <div class="llm-skill-pane-title"><span>技能列表</span><span><button type="button" data-import>导入文件夹</button><button type="button" data-new>新增</button></span></div>
                        <div class="llm-skill-list" data-list></div>
                    </section>
                    <section class="llm-skill-editor">
                        <label>名称<input data-name maxlength="120" placeholder="例如：产品摄影提示词"></label>
                        <label>Skill 文件内容<textarea data-content maxlength="120000" placeholder="# Skill 名称\n\n写下要让 LLM 遵循的工作流程、约束和输出格式。"></textarea></label>
                        <div class="llm-skill-actions"><button type="button" data-delete>删除当前</button><button type="button" class="primary" data-save>保存 Skill</button></div>
                    </section>
                </div>
                <div class="llm-skill-foot">勾选技能后关闭窗口，当前对话或画布节点会使用所选 Skills。</div>
            </div>`;
            document.body.appendChild(modal);
            const listEl = modal.querySelector('[data-list]');
            const nameEl = modal.querySelector('[data-name]');
            const contentEl = modal.querySelector('[data-content]');
            const importInput = modal.querySelector('[data-import-input]');

            function notify(){ if(typeof onChange === 'function') onChange([...selected]); }
            function loadEditor(id){
                activeId = String(id || '');
                const skill = skills.find(item => String(item.id) === activeId);
                nameEl.value = skill?.name || '';
                contentEl.value = skill?.content || '';
                modal.querySelectorAll('[data-row]').forEach(row => row.classList.toggle('active', row.dataset.row === activeId));
            }
            function renderList(){
                listEl.innerHTML = skills.length ? skills.map(skill => `<div class="llm-skill-row ${String(skill.id) === activeId ? 'active' : ''}" data-row="${escapeHtml(skill.id)}">
                    <input type="checkbox" data-select="${escapeHtml(skill.id)}" ${selected.has(String(skill.id)) ? 'checked' : ''}>
                    <button type="button" data-open="${escapeHtml(skill.id)}"><span>${escapeHtml(skill.name || skill.id)}</span><small>${escapeHtml(skill.description || skill.id)}</small></button>
                </div>`).join('') : '<div class="llm-skill-empty">还没有 Skill</div>';
                listEl.querySelectorAll('[data-select]').forEach(input => input.onchange = event => {
                    const id = String(event.target.dataset.select);
                    if(event.target.checked) selected.add(id); else selected.delete(id);
                    notify();
                });
                listEl.querySelectorAll('[data-open]').forEach(button => button.onclick = () => loadEditor(button.dataset.open));
            }
            modal.querySelector('[data-new]').onclick = () => { activeId = ''; nameEl.value = ''; contentEl.value = ''; renderList(); nameEl.focus(); };
            modal.querySelector('[data-import]').onclick = () => importInput.click();
            importInput.onchange = async () => {
                const files = [...(importInput.files || [])];
                if(!files.length) return;
                const form = new FormData();
                files.forEach(file => form.append('files', file, file.webkitRelativePath || file.name));
                const response = await fetch('/api/llm-skills/import', {method:'POST', body:form});
                if(!response.ok){ alert((await response.json()).detail || '导入 Skill 失败'); return; }
                const data = await response.json();
                skills = (await load(true)).slice();
                if(data.skill?.id){ activeId = data.skill.id; selected.add(activeId); notify(); }
                renderList(); loadEditor(activeId);
                importInput.value = '';
            };
            modal.querySelector('[data-save]').onclick = async () => {
                const name = String(nameEl.value || '').trim();
                const content = String(contentEl.value || '').trim();
                if(!name || !content){ alert('请填写 Skill 名称和内容'); return; }
                const response = await fetch('/api/llm-skills', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:activeId, name, content})});
                if(!response.ok){ alert((await response.json()).detail || '保存 Skill 失败'); return; }
                const data = await response.json();
                skills = (await load(true)).slice();
                const saved = data.skill || skills.find(item => item.name === name);
                if(saved){ activeId = saved.id; selected.add(saved.id); notify(); }
                renderList(); loadEditor(activeId);
            };
            modal.querySelector('[data-delete]').onclick = async () => {
                if(!activeId || !confirm('确定删除当前 Skill 吗？')) return;
                const response = await fetch(`/api/llm-skills/${encodeURIComponent(activeId)}`, {method:'DELETE'});
                if(!response.ok){ alert((await response.json()).detail || '删除 Skill 失败'); return; }
                selected.delete(activeId); skills = (await load(true)).slice(); activeId = skills[0]?.id || ''; notify(); renderList(); loadEditor(activeId);
            };
            modal.querySelector('[data-close]').onclick = removeModal;
            modal.onclick = event => { if(event.target === modal) removeModal(); };
            renderList();
            loadEditor(activeId);
        }).catch(error => alert(error.message || '加载 Skills 失败'));
    }

    window.LLMSkills = {load, refreshSelect, openManager, get list(){ return skills.slice(); }};
})();
