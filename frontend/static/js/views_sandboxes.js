/* views_sandboxes.js — sandbox lifecycle console (platform-owned + discovered) */
(function () {
  const { ref, reactive, onMounted, onUnmounted } = Vue;

  window.SandboxesView = {
    components: { Badge: window.Badge, Modal: window.Modal, TerminalPane: window.TerminalPane, PageTabs: window.PageTabs },
    setup() {
      const items = ref([]);
      const discovered = ref([]);
      const templates = ref([]);
      const loading = ref(false);
      const autoRefresh = ref(false);
      let autoTimer = null;
      const showCreate = ref(false);
      const creating = ref(false);
      const form = reactive({
        name: '', template: 'ubuntu', cpu: '500m', memory: '512Mi',
        ttlHours: 24, nodePort: false, gpu: 0, description: '',
      });
      const termTarget = ref(null);
      const tab = ref('platform');
      const renewTarget = ref(null);
      const renewHours = ref(24);
      const editDesc = ref(null);   // {name, description}
      const nodeIP = ref('');

      async function loadAll(silent) {
        if (!silent) loading.value = true;
        try {
          const [lst, dscv] = await Promise.all([
            API.get('/api/sandboxes'),
            API.get('/api/sandboxes/discovered'),
          ]);
          items.value = lst.items || [];
          if (items.value.length && items.value[0].nodeIP) nodeIP.value = items.value[0].nodeIP;
          discovered.value = dscv.items || [];
        } catch (e) { if (!silent) toast(e.message, 'error'); }
        loading.value = false;
      }
      async function loadTemplates() {
        try {
          const r = await API.get('/api/sandboxes/templates');
          templates.value = r.templates || [];
        } catch (e) {}
      }
      function tplByKey(key) {
        return templates.value.find((t) => t.key === key) || null;
      }
      function onTemplateChange() {
        const t = tplByKey(form.template);
        form.nodePort = !!(t && t.defaultNodePort);
      }
      async function createSandbox() {
        creating.value = true;
        try {
          await API.post('/api/sandboxes', { ...form });
          showCreate.value = false;
          const t = tplByKey(form.template);
          toast(`沙箱 ${form.name} 创建成功${t && t.defaultNodePort ? '，稍后通过 NodePort 访问' : ''}`);
          await loadAll(true);
        } catch (e) { toast(e.message, 'error'); }
        creating.value = false;
      }
      async function act(name, action, body) {
        try {
          if (action === 'delete') await API.del('/api/sandboxes/' + name);
          else await API.post(`/api/sandboxes/${name}/${action}`, body || {});
          toast(`已${{ start: '启动', stop: '停止(回收已暂停)', renew: '续期', delete: '删除' }[action]} ${name}`);
          setTimeout(() => loadAll(true), 700);
        } catch (e) { toast(e.message, 'error'); }
      }
      async function saveDescription() {
        const t = editDesc.value;
        if (!t) return;
        try {
          await API.patch(`/api/sandboxes/${t.name}/description`, { description: t.description });
          editDesc.value = null;
          loadAll(true);
          toast('描述已更新');
        } catch (e) { toast(e.message, 'error'); }
      }
      async function openTerminal(sbx) {
        try {
          const pods = await API.get('/api/res/v1/pods/' + sbx.namespace +
            '?labelSelector=app%3D' + encodeURIComponent(sbx.name));
          const pod = (pods.items || [])[0];
          if (!pod) { toast('暂无运行中的容器组', 'error'); return; }
          const containers = (pod.spec.containers || []).map((c) => c.name);
          termTarget.value = { namespace: pod.metadata.namespace, name: pod.metadata.name, containers };
        } catch (e) { toast(e.message, 'error'); }
      }
      function accessURL(it) {
        if (it.nodePort && it.nodeIP) return `http://${it.nodeIP}:${it.nodePort}`;
        return '';
      }
      function expireState(it) {
        if (!it.expiresAt) return { text: '-', color: 'default' };
        const diff = it.expiresAt - Date.now() / 1000;
        if (it.paused) return { text: U.remain(it.expiresAt) + '（暂停中）', color: 'default' };
        if (diff <= 0) return { text: '已过期(待回收)', color: 'danger' };
        if (diff < 3600) return { text: U.remain(it.expiresAt) + '后回收', color: 'warning' };
        return { text: U.remain(it.expiresAt) + '后回收', color: 'success' };
      }
      function toggleAuto(v) {
        autoRefresh.value = v;
        clearInterval(autoTimer);
        if (v) autoTimer = setInterval(() => loadAll(true), 10000);
      }
      onMounted(() => { loadAll(); loadTemplates(); });
      onUnmounted(() => clearInterval(autoTimer));

      return {
        items, discovered, templates, loading, showCreate, creating, form,
        createSandbox, act, openTerminal, termTarget, tab, renewTarget, renewHours,
        expireState, U, autoRefresh, toggleAuto, loadAll, tplByKey, onTemplateChange,
        accessURL, editDesc, saveDescription,
      };
    },
    template: `
    <div>
      <div class="view-toolbar">
        <button class="btn primary" @click="showCreate=true">+ 创建沙箱</button>
        <button class="btn ghost" @click="loadAll()">刷新</button>
        <label class="chk" style="margin-left:auto"><input type="checkbox" :checked="autoRefresh" @change="toggleAuto($event.target.checked)"/> 自动刷新（10 秒）</label>
      </div>

      <PageTabs v-model="tab" :tabs="[
        {key:'platform',label:'平台沙箱', count:items.length},
        {key:'discovered',label:'发现的第三方沙箱', count:discovered.length}]"/>

      <!-- platform sandboxes -->
      <div class="card" style="margin-top:14px" v-if="tab==='platform'">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr>
              <th>名称</th><th>模板</th><th>状态</th><th>实时用量</th>
              <th>TTL 到期</th><th>访问方式</th><th>描述</th><th></th>
            </tr></thead>
            <tbody>
              <tr v-if="loading"><td colspan="8" class="empty">加载中…</td></tr>
              <tr v-else-if="!items.length"><td colspan="8" class="empty">还没有沙箱，点击右上角「创建沙箱」开始体验</td></tr>
              <tr v-for="it in items" :key="it.namespace">
                <td><span class="link strong">{{ it.name }}</span><div class="sublabels">{{ it.namespace }}</div></td>
                <td>{{ it.template }}</td>
                <td>
                  <Badge :text="it.status+' '+it.ready"
                     :color="it.status==='Running'?'success':(it.status==='Stopped'?'default':'warning')"/>
                  <div v-if="it.paused" class="sublabels" style="color:#64748b">TTL 已暂停</div>
                </td>
                <td class="mono small">{{ it.status==='Stopped' ? '-' : ((it.realCpu||'-') + ' / ' + (it.realMemory||'-')) }}</td>
                <td><Badge :text="expireState(it).text" :color="expireState(it).color"/></td>
                <td>
                  <template v-if="accessURL(it)">
                    <a :href="accessURL(it)" target="_blank" class="link">{{ accessURL(it) }}</a>
                  </template>
                  <template v-else-if="it.nodePort">NodePort <b class="mono">{{ it.nodePort }}</b></template>
                  <template v-else-if="it.clusterIP">ClusterIP {{ it.clusterIP }}</template>
                  <template v-else>-</template>
                </td>
                <td class="wrap muted" style="max-width:220px">
                  <span v-if="editDesc && editDesc.name===it.name" style="display:flex;gap:6px">
                    <input class="input" style="flex:1" v-model="editDesc.description" @keyup.enter="saveDescription"/>
                    <button class="mini-btn" @click="saveDescription">存</button>
                  </span>
                  <span v-else style="cursor:pointer" title="点击编辑描述"
                        @click="editDesc={name: it.name, description: it.description||''}">
                    {{ it.description || '点击添加描述…' }}
                  </span>
                </td>
                <td class="td-actions">
                  <button v-if="it.status!=='Running'" class="mini-btn" @click="act(it.name,'start')">启动</button>
                  <button v-if="it.status==='Running'" class="mini-btn" @click="openTerminal(it)">终端</button>
                  <button v-if="it.status==='Running'" class="mini-btn" @click="act(it.name,'stop')">停止</button>
                  <button class="mini-btn" @click="renewTarget=it;renewHours=24">续期</button>
                  <button class="mini-btn danger" @click="act(it.name,'delete')">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- discovered third-party sandboxes -->
      <div class="card" style="margin-top:14px" v-else>
        <div class="pad-s muted note-bar">
          自动发现集群中已存在的沙箱实例（E2B / agents.x-k8s.io Sandbox CR 等），仅做展示便于统一查看。
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>来源</th><th>命名空间</th><th>名称</th><th>状态</th><th>镜像</th><th>启动时间</th></tr></thead>
            <tbody>
              <tr v-if="!discovered.length"><td colspan="6" class="empty">未发现第三方沙箱实例</td></tr>
              <tr v-for="(d,i) in discovered" :key="d.source+d.namespace+d.name">
                <td><span class="chip">{{ d.source === 'opensandbox-pods' ? 'OpenSandbox/E2B Pod' : 'AgentSandbox CR' }}</span></td>
                <td>{{ d.namespace }}</td>
                <td class="mono">{{ d.name }}</td>
                <td><Badge :text="d.phase||'-'" :color="d.phase==='Running'||d.phase==='running'?'success':'default'"/></td>
                <td class="mono wrap">{{ d.image || '-' }}</td>
                <td>{{ d.startedAt ? U.ts(d.startedAt) : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- create modal -->
      <Modal v-if="showCreate" title="创建沙箱" width="680px" @close="showCreate=false">
        <div class="form-grid">
          <label class="fld">沙箱名称<input class="input" v-model="form.name" placeholder="如 dev-test01"/></label>
          <label class="fld">模板
            <select class="input sel" v-model="form.template" @change="onTemplateChange">
              <option v-for="t in templates" :key="t.key" :value="t.key">
                [{{ t.category || '通用' }}] {{ t.name }} — {{ t.description }}
              </option>
            </select>
          </label>
          <label class="fld">CPU 配额
            <select class="input sel" v-model="form.cpu">
              <option>250m</option><option>500m</option><option>1</option><option>2</option><option>4</option>
            </select>
          </label>
          <label class="fld">内存配额
            <select class="input sel" v-model="form.memory">
              <option>256Mi</option><option>512Mi</option><option>1Gi</option><option>2Gi</option><option>4Gi</option>
            </select>
          </label>
          <label class="fld">GPU 数量
            <select class="input sel" v-model.number="form.gpu">
              <option :value="0">不使用 GPU</option>
              <option v-for="n in [1,2,4,8]" :key="n" :value="n">{{ n }} 张（nvidia.com/gpu）</option>
            </select>
          </label>
          <label class="fld">有效时长（小时）<input class="input" type="number" min="1" v-model="form.ttlHours"/></label>
          <label class="fld chk-line"><input type="checkbox" v-model="form.nodePort"/> 暴露 NodePort 端口访问服务</label>
          <div class="fld muted small" style="align-self:end">
            {{ (tplByKey(form.template)||{}).image || '' }}
          </div>
        </div>
        <label class="fld">描述<textarea class="input area" rows="2" v-model="form.description"></textarea></label>
        <div class="muted pad-s">
          每个沙箱是独立命名空间，带 CPU/内存资源配额与默认 LimitRange。
          <b>停止沙箱会暂停 TTL 倒计时</b>，运行至到期后由后台自动回收。
          <span v-if="form.gpu>0"> GPU 沙箱需要集群已安装 NVIDIA device plugin。</span>
        </div>
        <template #foot>
          <button class="btn ghost" @click="showCreate=false">取消</button>
          <button class="btn primary" :disabled="creating||!form.name" @click="createSandbox">{{ creating?'创建中…':'创建' }}</button>
        </template>
      </Modal>

      <!-- terminal modal -->
      <Modal v-if="termTarget" :title="'终端 — '+termTarget.namespace" width="860px" @close="termTarget=null">
        <TerminalPane :namespace="termTarget.namespace" :podname="termTarget.name"/>
      </Modal>

      <!-- renew modal -->
      <Modal v-if="renewTarget" :title="'续期 '+renewTarget.name" @close="renewTarget=null">
        <label class="fld">延长时长（小时）
          <select class="input sel" v-model="renewHours">
            <option :value="24">24 小时</option><option :value="72">72 小时</option>
            <option :value="168">7 天</option><option :value="720">30 天</option>
          </select>
        </label>
        <template #foot>
          <button class="btn ghost" @click="renewTarget=null">取消</button>
          <button class="btn primary" @click="act(renewTarget.name,'renew',{hours:Number(renewHours)});renewTarget=null">确认续期</button>
        </template>
      </Modal>
    </div>`,
  };
})();
