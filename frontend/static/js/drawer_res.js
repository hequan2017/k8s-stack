/* drawer_res.js — unified resource detail drawer with info/YAML/log/terminal tabs */
(function () {
  window.ResDrawer = {
    components: {
      KVList: window.KVList,
      Badge: window.Badge,
      PageTabs: window.PageTabs,
      LogViewer: window.LogViewer,
      TerminalPane: window.TerminalPane,
    },
    props: {
      gvrPath: String,        // e.g. "apps/v1/deployments"
      namespaced: Boolean,
      item: Object,           // full object json
    },
    emits: ['close', 'changed'],
    data() {
      return {
        tab: 'info',
        tabs: [{ key: 'info', label: '资源信息' }, { key: 'yaml', label: 'YAML' }],
        yamlText: '',
        saving: false,
        relatedPods: [],
        podPhaseBy: {},
        scaleOpen: false, scaleTo: 0,
        restarting: false,
        detailJSON: null,
      };
    },
    computed: {
      meta() { return this.item?.metadata || {}; },
      isPod() { return this.item?.kind === 'Pod'; },
      kindKey() {
        const k = (this.item?.kind || '').toLowerCase();
        if (['deployment','statefulset','daemonset','replicaset','job'].includes(k)) return k;
        if (k === 'cronjob') return 'cronjob';
        return '';
      },
      workloadActionsAvailable() {
        return ['deployment','statefulset','daemonset'].includes(this.kindKey);
      },
      hasScale() {
        return ['deployment','statefulset','replicaset'].includes(this.kindKey) || this.kindKey === 'cronjob' ? false : ['deployment','statefulset','replicaset'].includes(this.kindKey);
      },
      selectorLabels() {
        return U.downField(this.item, 'spec', 'selector', 'matchLabels') ||
               U.downField(this.item, 'spec', 'jobTemplate', 'spec', 'selector', 'matchLabels') || null;
      },
      containerNames() {
        return ((this.isPod ? (U.downField(this.item,'status','containerStatuses')||[]) : [])
          .map((c)=>c.name)).join(', ');
      },
      statusBadges() {
        const out = [];
        if (this.isPod) {
          out.push({ color: U.podStatusColor(this.item), text: U.podStatusText(this.item) });
        }
        return out;
      },
    },
    async mounted() {
      this.yamlText = U.toYAML(JSON.parse(JSON.stringify(this.item)));
      if (this.selectorLabels) await this.loadRelatedPods();
      else if (this.isPod) this.relatedPods = [this.item];
    },
    methods: {
      kvItems() {
        const m = this.meta;
        const age = U.age(m.creationTimestamp);
        const items = [
          { k: '名称', v: m.name },
          { k: '命名空间', v: this.namespaced ? m.namespace : '（集群级）' },
          { k: '类型', v: this.item.kind + (m.ownerReferences?.length ? `（属主 ${m.ownerReferences[0].kind}/${m.ownerReferences[0].name}）` : '') },
          { k: '运行时间', v: age },
          { k: '版本 UID', v: (m.uid || '').slice(0, 13) + '…' },
        ];
        if (this.isPod) {
          items.push(
            { k: '状态', v: U.podStatusText(this.item) },
            { k: '节点', v: U.downField(this.item, 'spec', 'nodeName') },
            { k: 'Pod IP', v: U.downField(this.item, 'status', 'podIP') });
        }
        if (this.kindKey === 'deployment' || this.kindKey === 'statefulset') {
          items.push({
            k: '副本',
            v: `${(U.downField(this.item,'status','readyReplicas'))||0} / ${(U.downField(this.item,'spec','replicas'))||0}`,
          });
          const img = [];
          (U.downField(this.item,'spec','template','spec','containers')||[]).forEach((c)=>img.push(c.image));
          items.push({ k: '镜像', v: img.join('\n') });
        }
        if (m.annotations) {
          const np = m.annotations['kubestack.dev/nodeport'];
          if (np) items.push({ k: 'NodePort', v: np });
        }
        return items;
      },
      labelsKV(obj) {
        return Object.entries(obj || {}).map(([k,v]) => ({k, v}));
      },
      async loadRelatedPods() {
        try {
          const sel = Object.entries(this.selectorLabels)
            .map(([k, v]) => `${k}=${v}`).join(',');
          const ns = this.meta.namespace;
          const r = await API.get('/api/res/v1/pods/' + ns + '?labelSelector=' + encodeURIComponent(sel));
          this.relatedPods = r.items || [];
        } catch (e) { this.relatedPods = []; }
      },
      async saveYaml() {
        this.saving = true;
        try {
          const r = await API.post('/api/apply', { manifest: this.yamlText });
          const bad = (r.results || []).filter((x) => !x.ok);
          if (bad.length) throw new Error(bad[0].error);
          this.$toast('已应用');
          this.$emit('changed');
          const fresh = await API.get('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + this.meta.namespace + '/' + this.meta.name
                             : '/' + this.meta.name));
          this.detailJSON = fresh;
          this.item = fresh;
          this.yamlText = U.toYAML(JSON.parse(JSON.stringify(fresh)));
        } catch (e) { this.$toast('保存失败: ' + e.message, 'error'); }
        this.saving = false;
      },
      currentReplicas() { return U.downField(this.item,'spec','replicas') || 0; },
      openScale() { this.scaleTo = this.currentReplicas(); this.scaleOpen = true; },
      async doScale() {
        try {
          await API.patch('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + this.meta.namespace + '/' + this.meta.name
                             : '/' + this.meta.name),
            { spec: { replicas: Number(this.scaleTo) } });
          this.scaleOpen = false;
          this.$toast('已调整副本数为 ' + this.scaleTo);
          this.$emit('changed');
        } catch (e) { this.$toast('失败: ' + e.message, 'error'); }
      },
      async doRestart() {
        this.restarting = true;
        try {
          await API.patch('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + this.meta.namespace + '/' + this.meta.name
                             : '/' + this.meta.name),
            { spec: { template: { metadata: { annotations:
              { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } });
          this.$toast('已触发滚动重启');
          this.$emit('changed');
        } catch (e) { this.$toast('失败: ' + e.message, 'error'); }
        this.restarting = false;
      },
      async deleteItem() {
        if (!confirm(`确认删除 ${this.meta.name}?`)) return;
        try {
          await API.del('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + this.meta.namespace + '/' + this.meta.name
                             : '/' + this.meta.name));
          this.$toast('已删除');
          this.$emit('changed');
          this.$emit('close');
        } catch (e) { this.$toast('失败: ' + e.message, 'error'); }
      },
      refreshSelf() { /* children handled internally */ },
    },
    template: `
    <Drawer width="960px" :title="meta.name" @close="$emit('close')">
      <template #subtitle>
        <div class="drawer-sub">
          <Badge v-for="(b,i) in statusBadges" :key="i" :text="b.text" :color="b.color"/>
          <span class="muted">{{ item.apiVersion }} / {{ item.kind }}</span>
        </div>
      </template>

      <div class="drawer-actions">
        <button v-if="workloadActionsAvailable" class="btn ghost" :disabled="restarting" @click="doRestart">滚动重启</button>
        <button v-if="hasScale" class="btn ghost" @click="openScale">扩缩容</button>
        <button class="btn ghost danger-text" @click="deleteItem">删除</button>
      </div>

      <PageTabs style="margin-top:12px"
        :tabs="[...tabs, ...((isPod) ? [{key:'logs',label:'日志'},{key:'term',label:'终端'}] : [])]"
        v-model="tab"/>

      <div v-show="tab==='info'" class="tabpane">
        <div class="twocol">
          <div class="panel">
            <h4>基本信息</h4>
            <KVList :items="kvItems()"/>
          </div>
          <div class="panel">
            <h4>标签</h4>
            <KVList :items="labelsKV(meta.labels)"/>
            <h4 style="margin-top:14px">注解</h4>
            <KVList :items="labelsKV(Object.fromEntries(Object.entries(meta.annotations||{}).slice(0,8)))"/>
          </div>
        </div>
        <div v-if="relatedPods.length && !isPod" class="panel" style="margin-top:14px">
          <h4>关联容器组（{{ relatedPods.length }}）</h4>
          <table class="tbl simple">
            <thead><tr><th>名称</th><th>状态</th><th>节点</th><th>重启</th></tr></thead>
            <tbody><tr v-for="p in relatedPods" :key="p.metadata.name">
              <td>{{ p.metadata.name }}</td>
              <td><Badge :text="U.podStatusText(p)" :color="U.podStatusColor(p)"/></td>
              <td>{{ p.spec.nodeName }}</td>
              <td>{{ (p.status.containerStatuses||[]).reduce((a,c)=>a+(c.restartCount||0),0) }}</td>
            </tr></tbody>
          </table>
        </div>
      </div>

      <div v-show="tab==='yaml'" class="tabpane">
        <textarea class="code-editor tall" v-model="yamlText" spellcheck="false"></textarea>
        <div style="margin-top:10px;display:flex;gap:10px">
          <button class="btn primary" :disabled="saving" @click="saveYaml">{{ saving?'应用中…':'保存并应用' }}</button>
          <button class="btn ghost" @click="yamlText = U.toYAML(detailJSON || item)">还原</button>
        </div>
      </div>

      <LogViewer v-if="isPod" v-show="tab==='logs'" class="tabpane"
        :namespace="meta.namespace" :podname="meta.name"/>
      <TerminalPane v-if="isPod" v-show="tab==='term'" class="tabpane"
        :namespace="meta.namespace" :podname="meta.name"/>
    </Drawer>`,
  };
})();
