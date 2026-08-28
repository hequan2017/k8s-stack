/* components.js — shared UI building blocks (KubeSphere-flavoured) */
(function () {
  /* ---------------- badge ---------------- */
  window.Badge = {
    props: { text: String, color: { type: String, default: 'default' } },
    template: `<span class="badge" :class="'badge-' + color"><i class="dot"></i>{{ text }}</span>`,
  };

  /* ---------------- modal ---------------- */
  window.Modal = {
    props: { title: String, width: { type: String, default: '560px' } },
    emits: ['close'],
    template: `
    <div class="modal-mask" @click.self="$emit('close')">
      <div class="modal" :style="{width}">
        <div class="modal-head">
          <span class="modal-title">{{ title }}</span>
          <button class="icon-btn" @click="$emit('close')">✕</button>
        </div>
        <div class="modal-body"><slot></slot></div>
        <div class="modal-foot"><slot name="foot"></slot></div>
      </div>
    </div>`,
  };

  /* ---------------- drawer (right side detail panel) ---------------- */
  window.Drawer = {
    props: { title: String, width: { type: String, default: '900px' } },
    emits: ['close'],
    template: `
    <div class="drawer-mask" @click.self="$emit('close')">
      <div class="drawer" :style="{width}">
        <div class="drawer-head">
          <div>
            <div class="drawer-title">{{ title }}</div>
            <slot name="subtitle"></slot>
          </div>
          <button class="icon-btn" @click="$emit('close')">✕</button>
        </div>
        <div class="drawer-body"><slot></slot></div>
      </div>
    </div>`,
  };

  /* ---------------- tabs ---------------- */
  window.PageTabs = {
    props: { tabs: Array, modelValue: String },
    emits: ['update:modelValue'],
    template: `
    <div class="page-tabs">
      <button v-for="t in tabs" :key="t.key"
        class="ptab" :class="{active: t.key === modelValue}"
        @click="$emit('update:modelValue', t.key)">
        {{ t.label }} <span v-if="t.count != null" class="ptab-count">{{ t.count }}</span>
      </button>
    </div>`,
  };

  /* ---------------- generic resource table ----------------
     props.gvrPath : "apps/v1/deployments" or "v1/pods"
     rows fetched with current namespace from store unless fixedNs given.
     Every table carries a built-in detail drawer, so 详情 works on all pages;
     parents may still intercept via @detail (used by pods & workloads).
  */
  window.ResTable = {
    components: { Badge: window.Badge, Modal: window.Modal },
    props: {
      gvrPath: String,
      label: String,
      namespaced: { type: Boolean, default: true },
      columns: { type: Array, default: () => [] },  // extra column defs {key,label,render?(row)}
      actions: { type: Object, default: () => ({ edit: true, del: true }) },
      kindPlural: String,                        // override plural path segment if differs
    },
    setup(props) { return { store: window.store }; },
    data() {
      return { rows: [], loading: false, error: '', q: '', editing: null,
               editYaml: '', saving: false, confirmDel: null, innerDetail: null };
    },
    computed: {
      filtered() {
        const kw = this.q.trim().toLowerCase();
        if (!kw) return this.rows;
        return this.rows.filter(
          (r) => (r.metadata?.name || '').toLowerCase().includes(kw) ||
                 (r.metadata?.namespace || '').toLowerCase().includes(kw));
      },
      basePath() {
        return '/api/res/' + (this.kindPlural || this.gvrPath);
      },
    },
    methods: {
      async refresh() {
        this.loading = true; this.error = '';
        try {
          let url = '/api/res/' + this.pathWithNS();
          const r = await API.get(url);
          this.rows = (r.items || []).sort((a,b)=>
            (b.metadata.creationTimestamp||'').localeCompare(a.metadata.creationTimestamp||''));
        } catch (e) { this.error = e.message; this.rows = []; }
        this.loading = false;
      },
      pathWithNS() {
        let p = this.gvrPath;
        if (this.namespaced && window.store.namespace !== '_all' ) {
          p += '/' + window.store.namespace;
        }
        return p;
      },
      age(r) { return U.age(r.metadata.creationTimestamp); },
      openDetail(r) {
        if (this.$attrs && this.$attrs.onDetail) {
          this.$emit('detail', r);       // parent provides its own drawer
        } else {
          this.innerDetail = r;          // built-in drawer: works on every page
        }
      },
      async edit(r) {
        try {
          const full = await API.get('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + r.metadata.namespace + '/' + r.metadata.name : '/' + r.metadata.name));
          this.editing = r;
          this.editYaml = U.toYAML(JSON.parse(JSON.stringify(full)));
        } catch (e) { this.$toast(e.message, 'error'); }
      },
      async saveEdit() {
        this.saving = true;
        try {
          // YAML -> object: use simple parse via Function-free approach: server accepts JSON; do local yaml2json via our own restricted parser on /api/apply instead.
          const r = await API.post('/api/apply', { manifest: this.editYaml });
          const bad = (r.results || []).filter((x) => !x.ok);
          if (bad.length) throw new Error(bad[0].error);
          this.editing = null;
          this.refresh();
          this.$toast('已保存');
        } catch (e) { this.$toast('保存失败: ' + e.message, 'error'); }
        this.saving = false;
      },
      async del(r) {
        this.confirmDel = null;
        try {
          await API.del('/api/res/' + this.gvrPath +
            (this.namespaced ? '/' + r.metadata.namespace + '/' + r.metadata.name : '/' + r.metadata.name));
          this.refresh();
          this.$toast('已删除 ' + r.metadata.name);
        } catch (e) { this.$toast('删除失败: ' + e.message, 'error'); }
      },
    },
    mounted() {
      this.refresh();
      this._onRefresh = () => this.refresh();
      window.bus.on('refresh-all', this._onRefresh);
    },
    unmounted() {
      if (this._onRefresh) window.bus.off('refresh-all', this._onRefresh);
    },
    template: `
    <div class="res-table card">
      <div class="table-toolbar">
        <input class="input search" v-model="q" placeholder="搜索名称…"/>
        <button class="btn ghost" @click="refresh">刷新</button>
      </div>
      <div v-if="error" class="alert error">{{ error }}</div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th style="min-width:180px">名称</th>
            <th v-if="namespaced">命名空间</th>
            <slot name="cols"></slot>
            <th v-for="c in columns" :key="c.key">{{ c.label }}</th>
            <th>创建时间</th>
            <th class="th-actions"></th>
          </tr></thead>
          <tbody>
            <tr v-if="loading"><td :colspan="6+columns.length" class="empty">加载中…</td></tr>
            <tr v-else-if="!filtered.length"><td :colspan="6+columns.length" class="empty">暂无数据</td></tr>
            <tr v-for="r in filtered" :key="(r.metadata.namespace||'')+'/'+r.metadata.name">
              <td>
                <a href="javascript:;" class="link strong" @click.stop="openDetail(r)">{{ r.metadata.name }}</a>
                <div class="sublabels" v-if="r.metadata.labels && Object.keys(r.metadata.labels).length">
                  {{ Object.entries(r.metadata.labels).slice(0,3).map(([k,v])=>k+'='+v).join(' · ') }}
                </div>
              </td>
              <td v-if="namespaced">{{ r.metadata.namespace }}</td>
              <slot name="cells" :row="r"></slot>
              <td v-for="c in columns" :key="c.key">{{ c.render ? c.render(r) : '-' }}</td>
              <td>{{ age(r) }}</td>
              <td class="td-actions">
                <button class="mini-btn" @click.stop="openDetail(r)">详情</button>
                <button v-if="actions.edit" class="mini-btn" @click.stop="edit(r)">编辑</button>
                <button v-if="actions.del" class="mini-btn danger" @click.stop="confirmDel=r">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <Modal v-if="editing" :title="'编辑 '+(editing.metadata.name)" width="760px" @close="editing=null">
        <textarea class="code-editor" v-model="editYaml" spellcheck="false"></textarea>
        <template #foot>
          <button class="btn ghost" @click="editing=null">取消</button>
          <button class="btn primary" :disabled="saving" @click="saveEdit">{{ saving?'保存中…':'保存并应用' }}</button>
        </template>
      </Modal>
      <Modal v-if="confirmDel" :title="'删除确认'" @close="confirmDel=null">
        <p>确定要删除 <b>{{ confirmDel.metadata.name }}</b> 吗？此操作不可恢复。</p>
        <template #foot>
          <button class="btn ghost" @click="confirmDel=null">取消</button>
          <button class="btn danger" @click="del(confirmDel)">确认删除</button>
        </template>
      </Modal>
      <ResDrawer v-if="innerDetail" :gvr-path="gvrPath" :namespaced="namespaced"
                 :item="innerDetail" @close="innerDetail=null"/>
    </div>`,
  };

  /* ---------------- KV list (metadata panel) ---------------- */
  window.KVList = {
    props: { items: Array }, // [{k,v}]
    template: `
    <div class="kvlist">
      <div v-for="(it,i) in items.filter(x=>x.v!==undefined && x.v!==null && x.v!=='')" :key="i" class="kv">
        <div class="kv-k">{{ it.k }}</div>
        <div class="kv-v">{{ it.v }}</div>
      </div>
    </div>`,
  };

  window.ProgressStat = {
    props: { label: String, percent: Number, used: String, total: String },
    template: `
    <div class="progstat">
      <div class="ps-head"><span>{{ label }}</span><span class="ps-pct">{{ percent==null?'-':percent+'%' }}</span></div>
      <div class="ps-bar"><div class="ps-fill" :class="{warn:percent>=70,danger:percent>=90}" :style="{width:(percent||0)+'%'}"></div></div>
      <div class="ps-sub">{{ used }} / {{ total }}</div>
    </div>`,
  };
})();
