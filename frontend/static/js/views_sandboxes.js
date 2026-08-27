/* views_sandboxes.js — sandbox lifecycle console (platform-owned + discovered) */
(function () {
  const { ref, reactive, onMounted } = Vue;

  window.SandboxesView = {
    components: { Badge: window.Badge, Modal: window.Modal, TerminalPane: window.TerminalPane, PageTabs: window.PageTabs },
    setup() {
      const items = ref([]);
      const discovered = ref([]);
      const templates = ref([]);
      const loading = ref(false);
      const showCreate = ref(false);
      const creating = ref(false);
      const form = reactive({
        name: '', template: 'ubuntu', cpu: '500m', memory: '512Mi',
        ttlHours: 24, nodePort: false, description: '',
      });
      const termTarget = ref(null);   // {namespace,name,containers}
      const tab = ref('platform');
      const renewTarget = ref(null);
      const renewHours = ref(24);

      async function loadAll() {
        loading.value = true;
        try {
          const [lst, dscv] = await Promise.all([
            API.get('/api/sandboxes'),
            API.get('/api/sandboxes/discovered'),
          ]);
          items.value = lst.items || [];
          discovered.value = dscv.items || [];
        } catch (e) { toast(e.message, 'error'); }
        loading.value = false;
      }
      async function loadTemplates() {
        try {
          const r = await API.get('/api/sandboxes/templates');
          templates.value = r.templates || [];
        } catch (e) {}
      }
      async function createSandbox() {
        creating.value = true;
        try {
          await API.post('/api/sandboxes', { ...form });
          showCreate.value = false;
          toast('沙箱创建成功，正在启动…');
          setTimeout(loadAll, 800);
        } catch (e) { toast(e.message, 'error'); }
        creating.value = false;
      }
      async function act(name, action, body) {
        try {
          if (action === 'delete') await API.del('/api/sandboxes/' + name);
          else await API.post(`/api/sandboxes/${name}/${action}`, body || {});
          toast(`已${{ start: '启动', stop: '停止', renew: '续期', delete: '删除' }[action]} ${name}`);
          setTimeout(loadAll, 700);
        } catch (e) { toast(e.message, 'error'); }
      }
      async function openTerminal(sbx) {
        try {
          // find the main pod inside the sandbox namespace
          const pods = await API.get('/api/res/v1/pods/' + sbx.namespace +
            '?labelSelector=app%3D' + encodeURIComponent(sbx.name));
          const pod = (pods.items || [])[0];
          if (!pod) { toast('暂无运行中的容器组', 'error'); return; }
          const containers = (pod.spec.containers || []).map((c) => c.name);
          termTarget.value = { namespace: pod.metadata.namespace, name: pod.metadata.name, containers };
        } catch (e) { toast(e.message, 'error'); }
      }
      function expireState(it) {
        if (!it.expiresAt) return { text: '-', color: 'default' };
        const diff = it.expiresAt - Date.now() / 1000;
        if (diff <= 0) return { text: '已过期(待回收)', color: 'danger' };
        if (diff < 3600) return { text: U.remain(it.expiresAt) + '后回收', color: 'warning' };
        return { text: U.remain(it.expiresAt) + '后回收', color: 'success' };
      }
      onMounted(() => { loadAll(); loadTemplates(); });

      return {
        items, discovered, templates, loading, showCreate, creating, form,
        createSandbox, act, openTerminal, termTarget, tab, renewTarget, renewHours,
        expireState, U,
      };
    },
    template: `
    <div>
      <div class="view-toolbar">
        <button class="btn primary" @click="showCreate=true">+ 创建沙箱</button>
        <button class="btn ghost" @click="loadAll()">刷新</button>
      </div>

      <PageTabs v-model="tab" :tabs="[
        {key:'platform',label:'平台沙箱', count:items.length},
        {key:'discovered',label:'发现的第三方沙箱', count:discovered.length}]"/>

      <!-- platform sandboxes -->
      <div class="card" style="margin-top:14px" v-if="tab==='platform'">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr>
              <th>名称</th><th>模板</th><th>状态</th><th>CPU占用/配额</th><th>内存占用/配额</th>
              <th>TTL 到期</th><th>访问方式</th><th>描述</th><th></th>
            </tr></thead>
            <tbody>
              <tr v-if="loading"><td colspan="9" class="empty">加载中…</td></tr>
              <tr v-else-if="!items.length"><td colspan="9" class="empty">还没有沙箱，点击右上角「创建沙箱」开始体验</td></tr>
              <tr v-for="it in items" :key="it.namespace">
                <td><span class="link strong">{{ it.name }}</span><div class="sublabels">{{ it.namespace }}</div></td>
                <td>{{ it.template }}</td>
                <td><Badge :text="it.status+' '+it.ready"
                     :color="it.status==='Running'?'success':(it.status==='Stopped'?'default':'warning')"/></td>
                <td class="mono">{{ it.cpu || '-' }}</td>
                <td class="mono">{{ it.memory || '-' }}</td>
                <td><Badge :text="expireState(it).text" :color="expireState(it).color"/></td>
                <td>
                  <template v-if="it.nodePort">NodePort <b class="mono">{{ it.nodePort }}</b></template>
                  <template v-else-if="it.clusterIP">ClusterIP {{ it.clusterIP }}</template>
                  <template v-else>-</template>
                </td>
                <td class="wrap muted">{{ it.description || '-' }}</td>
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
      <Modal v-if="showCreate" title="创建沙箱" width="640px" @close="showCreate=false">
        <div class="form-grid">
          <label class="fld">沙箱名称<input class="input" v-model="form.name" placeholder="如 dev-test01"/></label>
          <label class="fld">模板
            <select class="input sel" v-model="form.template">
              <option v-for="t in templates" :key="t.key" :value="t.key">{{ t.name }} — {{ t.description }}</option>
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
          <label class="fld">有效时长（小时）<input class="input" type="number" min="1" v-model="form.ttlHours"/></label>
          <label class="fld chk-line"><input type="checkbox" v-model="form.nodePort"/> 暴露 NodePort 端口访问服务</label>
        </div>
        <label class="fld">描述<textarea class="input area" rows="2" v-model="form.description"></textarea></label>
        <div class="muted pad-s">每个沙箱是独立命名空间，带 CPU/内存资源配额与默认 LimitRange；到期后由后台自动回收。</div>
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
