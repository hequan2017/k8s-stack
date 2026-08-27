/* views_main.js — dashboard / nodes / namespaces / events / rbac / storage / crd explorer */
(function () {
  const { computed, onMounted, ref } = Vue;

  /* ================= Dashboard ================= */
  window.DashboardView = {
    components: { ProgressStat: window.ProgressStat, Badge: window.Badge },
    setup() {
      const data = ref(null);
      const error = ref('');
      const loading = ref(true);
      const events = ref([]);
      async function load() {
        loading.value = true; error.value = '';
        try {
          data.value = await API.get('/api/overview');
          const ev = await API.get('/api/events?type=Warning');
          events.value = (ev.items || []).slice(0, 8);
        } catch (e) { error.value = e.message; }
        loading.value = false;
      }
      onMounted(load);
      window.bus.on('ns-changed', load);
      return { data, error, loading, events, U };
    },
    template: `
    <div>
      <div class="stat-grid" v-if="data">
        <div class="statcard card"><div class="sc-num">{{ data.counts.namespaces }}</div><div class="sc-label">命名空间</div></div>
        <div class="statcard card"><div class="sc-num">{{ data.counts.podsRunning }}<span class="sc-sub">/{{ data.counts.pods }}</span></div><div class="sc-label">运行中的容器组</div></div>
        <div class="statcard card"><div class="sc-num">{{ data.counts.deployments }}</div><div class="sc-label">部署</div></div>
        <div class="statcard card"><div class="sc-num">{{ data.counts.services }}</div><div class="sc-label">服务</div></div>
        <div class="statcard card"><div class="sc-num">{{ data.counts.ingresses }}</div><div class="sc-label">路由</div></div>
        <div class="statcard card"><div class="sc-num">{{ data.counts.persistentVolumeClaims }}</div><div class="sc-label">存储声明</div></div>
      </div>

      <div class="twocol" style="margin-top:16px">
        <div class="panel card pad">
          <h4>集群资源用量</h4>
          <template v-if="data && data.usage.cpuPercent != null">
            <ProgressStat label="CPU 使用率" :percent="data.usage.cpuPercent"
              :used="data.usage.cpuUsed" :total="data.usage.cpuAllocatable"/>
            <ProgressStat label="内存使用率" :percent="data.usage.memoryPercent"
              :used="data.usage.memoryUsed" :total="data.usage.memoryAllocable"/>
          </template>
          <div v-else class="muted pad-s">metrics-server 不可用</div>
        </div>
        <div class="panel card pad">
          <h4>节点</h4>
          <table class="tbl simple" v-if="data">
            <thead><tr><th>名称</th><th>状态</th><th>角色</th><th>IP</th><th>CPU</th><th>内存</th></tr></thead>
            <tbody>
              <tr v-for="n in data.nodes" :key="n.name">
                <td>{{ n.name }}</td>
                <td><Badge :text="n.ready?'Ready':'NotReady'" :color="n.ready?'success':'danger'"/></td>
                <td>{{ n.roles.join(', ') || '-' }}</td>
                <td>{{ n.address }}</td>
                <td>{{ n.cpuPercent==null?'-':n.cpuPercent+'%' }}</td>
                <td>{{ n.memPercent==null?'-':n.memPercent+'%' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="twocol" style="margin-top:16px">
        <div class="panel card pad">
          <h4>资源占用 Top 10（容器组）</h4>
          <table class="tbl simple" v-if="data">
            <thead><tr><th>容器组</th><th>命名空间</th><th>CPU</th><th>内存</th></tr></thead>
            <tbody>
              <tr v-for="(p,i) in (data.topPods||[])" :key="i">
                <td class="mono">{{ p.name }}</td><td>{{ p.namespace }}</td>
                <td>{{ p.cpu }}</td><td>{{ p.memory }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="panel card pad">
          <h4>最近异常事件</h4>
          <div v-if="!events.length" class="muted pad-s">暂无告警事件 🎉</div>
          <div class="evitem" v-for="(e,i) in events" :key="i">
            <span class="evdot warn"></span>
            <div>
              <div class="evhead">{{ e.object }} · {{ e.reason }} · {{ e.count }}次</div>
              <div class="evmsg">{{ e.message }}</div>
              <div class="evtime">{{ U.ts(e.lastSeen) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  };

  /* ================= Nodes ================= */
  window.NodesView = {
    components: { ResTable: window.ResTable, Badge: window.Badge, Drawer: window.Drawer, KVList: window.KVList },
    setup() {
      const current = ref(null);
      const cordoning = ref(false);
      const nodesList = ref([]);
      const load = async () => {
        const r = await API.get('/api/res/v1/nodes');
        nodesList.value = r.items || [];
        if (current.value) {
          current.value = nodesList.value.find(
            (n) => n.metadata.name === current.value.metadata.name) || null;
        }
      };
      onMounted(load);
      const usageBar = (n) => null;
      async function cordon(name) {
        cordoning.value = true;
        await API.patch('/api/res/v1/nodes/' + name, { spec: { unschedulable: true } });
        cordoning.value = false; load();
      }
      async function uncordon(name) {
        cordoning.value = true;
        await API.patch('/api/res/v1/nodes/' + name, { spec: { unschedulable: false } });
        cordoning.value = false; load();
      }
      return { current, nodesList, load, cordon, uncordon, cordoning, U, usageBar };
    },
    template: `
    <div>
      <ResTable gvrPath="v1/nodes" :namespaced="false" label="节点" @detail="n => current = n">
        <template #cols><th>状态</th><th>角色</th><th>Kubelet</th><th>Pods</th></template>
        <template #cells="{row}">
          <td><Badge :text="(row.status.conditions||[]).some(c=>c.type==='Ready'&&c.status==='True')?'Ready':'NotReady'"
                     :color="(row.status.conditions||[]).some(c=>c.type==='Ready'&&c.status==='True')?'success':'danger'"/></td>
          <td>{{ Object.keys(row.metadata.labels||{}).filter(k=>k.startsWith('node-role.kubernetes.io/')).map(k=>k.replace('node-role.kubernetes.io/','')).join(',') || 'worker' }}</td>
          <td>{{ row.status.nodeInfo.kubeletVersion }}</td>
          <td>{{ row.status.allocatable?.pods ? '' : ''}}{{ row.status.capacity?.pods || '-' }}</td>
        </template>
      </ResTable>

      <Drawer v-if="current" width="820px" :title="current.metadata.name" @close="current=null;load()">
        <template #subtitle><span class="muted">{{ current.status.nodeInfo.osImage }}</span></template>
        <KVList :items="[
          {k:'内部 IP', v:(current.status.addresses||[]).find(a=>a.type==='InternalIP')?.address},
          {k:'操作系统', v:current.status.nodeInfo.osImage},
          {k:'运行时', v:current.status.nodeInfo.containerRuntimeVersion},
          {k:'kubelet', v:current.status.nodeInfo.kubeletVersion},
          {k:'Pod 容量', v:current.status.allocatable?.pods},
          {k:'可调度', v:(current.spec&&current.spec.unschedulable)?'否（已隔离）':'是'},
        ]"/>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button v-if="!(current.spec&&current.spec.unschedulable)" class="btn ghost" @click="cordon(current.metadata.name)">设为不可调度</button>
          <button v-else class="btn primary" @click="uncordon(current.metadata.name)">恢复调度</button>
        </div>
        <div class="panel" style="margin-top:14px">
          <h4>条件</h4>
          <table class="tbl simple">
            <thead><tr><th>类型</th><th>状态</th><th>原因</th><th>更新时间</th></tr></thead>
            <tbody><tr v-for="(c,i) in current.status.conditions" :key="i">
              <td>{{ c.type }}</td>
              <td><Badge :text="c.status" :color="c.status==='True'?'success':'default'"/></td>
              <td>{{ c.reason||'-' }}</td>
              <td>{{ U.ts(c.lastHeartbeatTime) }}</td>
            </tr></tbody>
          </table>
        </div>
      </Drawer>
    </div>`,
  };

  /* ================= Namespaces ================= */
  window.NamespacesView = {
    components: { ResTable: window.ResTable, Badge: window.Badge, Modal: window.Modal },
    setup() {
      const showCreate = ref(false);
      const form = Vue.reactive({ name: '', labels: '' });
      const creating = ref(false);
      const tableRef = ref(null);
      async function create() {
        creating.value = true;
        try {
          const body = { apiVersion: 'v1', kind: 'Namespace',
            metadata: { name: form.name.trim().toLowerCase() } };
          if (form.labels.trim()) {
            form.labels.split('\n').filter(Boolean).forEach((line) => {
              const [k, v] = line.split('=');
              if (v) body.metadata.labels = { ...(body.metadata.labels||{}), [k.trim()]: v.trim() };
            });
          }
          await API.post('/api/res/v1/namespaces?namespace=', body);
          showCreate.value = false;
          form.name = ''; form.labels = '';
          window.store.refreshNsOptions();
          if (tableRef.value) tableRef.value.refresh();
          toast('命名空间已创建');
        } catch (e) { toast('创建失败: ' + e.message, 'error'); }
        creating.value = false;
      }
      return { showCreate, form, creating, create, tableRef };
    },
    template: `
    <div>
      <div class="view-toolbar"><button class="btn primary" @click="showCreate=true">创建项目（命名空间）</button></div>
      <ResTable ref="tableRef" gvrPath="v1/namespaces" :namespaced="false" label="命名空间">
        <template #cols><th>阶段</th></template>
        <template #cells="{row}">
          <td><Badge :text="row.status.phase" :color="row.status.phase==='Active'?'success':'warning'"/></td>
        </template>
      </ResTable>
      <Modal v-if="showCreate" title="创建项目（命名空间）" @close="showCreate=false">
        <label class="fld">名称（小写字母/数字/-）<input class="input" v-model="form.name"/></label>
        <label class="fld">标签（每行 key=value，可选）<textarea class="input area" rows="3" v-model="form.labels"></textarea></label>
        <template #foot>
          <button class="btn ghost" @click="showCreate=false">取消</button>
          <button class="btn primary" :disabled="creating" @click="create">{{ creating?'创建中…':'创建' }}</button>
        </template>
      </Modal>
    </div>`,
  };

  /* ================= Events ================= */
  window.EventsView = {
    components: { Badge: window.Badge },
    setup() {
      const items = ref([]);
      const total = ref(0);
      const typeF = ref('');
      const nsF = ref('_all');
      const auto = ref(false);
      let timer = null;
      async function load() {
        try {
          let url = '/api/events';
          const qs = [];
          if (typeF.value) qs.push('type=' + typeF.value);
          if (nsF.value !== '_all') qs.push('namespace=' + nsF.value);
          if (qs.length) url += '?' + qs.join('&');
          const r = await API.get(url);
          items.value = r.items || [];
          total.value = r.total;
        } catch (e) { toast(e.message, 'error'); }
      }
      function toggleAuto(v) {
        auto.value = v;
        clearInterval(timer);
        if (v) timer = setInterval(load, 8000);
      }
      onMounted(load);
      window.bus.on('ns-changed', () => { nsF.value = store.namespace; load(); });
      return { items, total, typeF, nsF, auto, load, toggleAuto, U };
    },
    template: `
    <div>
      <div class="card pad toolbar-row">
        <select class="input sel" v-model="typeF" @change="load()">
          <option value="">全部类型</option><option value="Warning">Warning</option><option value="Normal">Normal</option>
        </select>
        <select class="input sel" v-model="nsF" @change="load()">
          <option value="_all">全部命名空间</option>
          <option v-for="n in store.nsOptions.filter(x=>x!=='_all')" :key="n" :value="n">{{ n }}</option>
        </select>
        <label class="chk"><input type="checkbox" :checked="auto" @change="toggleAuto($event.target.checked)"/> 自动刷新</label>
        <button class="btn ghost" @click="load()">刷新</button>
        <span class="muted">共 {{ total }} 条事件</span>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th style="width:170px">最后出现</th><th>类型</th><th>对象</th><th>原因</th><th>次数</th><th>消息</th></tr></thead>
            <tbody>
              <tr v-if="!items.length"><td colspan="6" class="empty">暂无事件</td></tr>
              <tr v-for="(e,i) in items" :key="i">
                <td>{{ U.ts(e.lastSeen) }}</td>
                <td><Badge :text="e.type" :color="e.type==='Warning'?'danger':'primary'"/></td>
                <td class="mono">{{ e.object }}</td>
                <td>{{ e.reason }}</td>
                <td>{{ e.count }}</td>
                <td class="wrap">{{ e.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,
  };
})();
