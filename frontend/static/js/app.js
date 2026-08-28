/* app.js — shell layout, hash router, namespace switcher, login gate */
(function () {
  const { createApp, reactive, ref, computed, onMounted } = Vue;

  /* -------- global store & tiny event bus -------- */
  window.store = reactive({
    namespace: localStorage.getItem('kubestack_ns') || '_all',
    nsOptions: ['_all'],
    version: null,
  });
  store.refreshNsOptions = async function () {
    try {
      const r = await API.get('/api/res/v1/namespaces?limit=1000');
      this.nsOptions = ['_all', ...(r.items || [])
        .filter((n) => n.status.phase === 'Active')
        .map((n) => n.metadata.name).sort()];
    } catch (e) {}
  };
  window.bus = (() => {
    const map = {};
    return {
      on(ev, fn) { (map[ev] = map[ev] || []).push(fn); },
      off(ev, fn) {
        if (!map[ev]) return;
        map[ev] = map[ev].filter((f) => f !== fn);
      },
      emit(ev, ...args) { (map[ev] || []).forEach((f) => { try { f(...args); } catch (e) {} }); },
    };
  })();
  window.toast = function (msg, level = 'ok') {
    window.dispatchEvent(new CustomEvent('app-toast', { detail: { msg, level } }));
  };

  /* -------- router table (matches KubeSphere information architecture) -------- */
  const ROUTES = [
    { path: '#/dashboard', label: '集群总览', view: 'DashboardView', group: 'overview' },
    { path: '#/nodes', label: '节点管理', view: 'NodesView', group: 'cluster' },
    { path: '#/namespaces', label: '项目管理（命名空间）', view: 'NamespacesView', group: 'cluster' },
    { path: '#/crds', label: 'CRD / 资源浏览器', view: 'CrdExplorerView', group: 'cluster' },
    { path: '#/rbac', label: '权限管理 RBAC', view: 'RbacView', group: 'cluster' },
    { path: '#/storage', label: '存储管理', view: 'StorageView', group: 'cluster' },
    { path: '#/workloads', label: '工作负载', view: 'WorkloadsView', group: 'project' },
    { path: '#/pods', label: '容器组 Pods', view: 'PodsView', group: 'project' },
    { path: '#/network', label: '服务与路由', view: 'NetworkView', group: 'project' },
    { path: '#/config', label: '配置中心', view: 'ConfigView', group: 'project' },
    { path: '#/events', label: '事件查询', view: 'EventsView', group: 'project' },
    { path: '#/sandboxes', label: '沙箱管理', view: 'SandboxesView', group: 'sandbox' },
    { path: '#/tools', label: 'YAML 应用中心', view: 'YamlApplyView', group: 'tools' },
  ];
  const NAV = [
    { key: 'overview', label: '总览', icon: '◱' },
    { key: 'cluster', label: '集群管理', icon: '⛁' },
    { key: 'project', label: '项目资源', icon: '▦', needsNs: true },
    { key: 'sandbox', label: '沙箱平台', icon: '⬚' },
    { key: 'tools', label: '运维工具', icon: '⚒' },
  ];

  /* -------- login gate component -------- */
  const LoginGate = {
    data() { return { user: 'admin', password: '', busy: false, err: '' }; },
    methods: {
      async submit() {
        if (!this.user.trim()) return;
        this.busy = true;
        try {
          await API.login(this.user, this.password);
          this.$emit('login-ok');
        } catch (e) {
          this.err = e.message;
        }
        this.busy = false;
      },
    },
    template: `
    <div class="login-mask">
      <form class="login-card" @submit.prevent="submit">
        <div class="login-logo"><span class="logo-mark">K</span> KubeStack 控制台</div>
        <div class="muted" style="margin-bottom:18px">开源 Kubernetes 一站式管理与沙箱平台</div>
        <label class="fld">用户名<input class="input" v-model="user"/></label>
        <label class="fld">密码<input class="input" type="password" v-model="password"/></label>
        <div v-if="err" class="alert error">{{ err }}</div>
        <button class="btn primary block" :disabled="busy">{{ busy?'验证中…':'登 录' }}</button>
      </form>
    </div>`,
  };

  /* -------- toast host -------- */
  const ToastHost = {
    data() { return { toasts: [] }; },
    mounted() {
      window.addEventListener('app-toast', (e) => {
        const id = Math.random().toString(36).slice(2);
        this.toasts.push({ id, ...e.detail });
        setTimeout(() => {
          this.toasts = this.toasts.filter((t) => t.id !== id);
        }, e.detail.level === 'error' ? 6000 : 3000);
      });
    },
    template: `
    <div class="toasts">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.level">{{ t.msg }}</div>
    </div>`,
  };

  const AppRoot = {
    components: Object.fromEntries(
      ROUTES.map((r) => [r.view, window[r.view]])
    ).constructor === Object ? {
      LoginGate, ToastHost,
      ...Object.fromEntries(ROUTES.map((r) => [r.view, window[r.view]])),
    } : {},
    setup() {
      const routePath = ref(location.hash || '#/dashboard');
      const needLogin = ref(false);
      const loaded = ref(false);

      function applyRoute() {
        routePath.value = location.hash || '#/dashboard';
        if (!(ROUTES.some((r) => r.path === routePath.value))) location.hash = '#/dashboard';
      }
      window.addEventListener('hashchange', applyRoute);

      onMounted(async () => {
        applyRoute();
        try {
          const v = await API.get('/api/version');
          store.version = v;
          needLogin.value = !!v.authEnabled && !API.hasToken();
        } catch (e) {}
        loaded.value = true;
        if (!needLogin.value) store.refreshNsOptions();
      });

      window.addEventListener('auth-expired', () => { needLogin.value = true; });
      // watch for the late listener race
      setTimeout(() => {
        if (store.version?.authEnabled && !API.hasToken()) needLogin.value = true;
      }, 0);

      const current = computed(() =>
        ROUTES.find((r) => r.path === routePath.value) || ROUTES[0]);

      function switchNS(e) {
        store.namespace = e.target.value;
        localStorage.setItem('kubestack_ns', store.namespace);
        bus.emit('ns-changed', store.namespace);
        bus.emit('refresh-all');
      }
      function logout() {
        API.logout();
        if (store.version?.authEnabled) { needLogin.value = true; }
      }

      return { store, routes: ROUTES, nav: NAV, routePath, current, needLogin, loaded, switchNS, logout };
    },
    template: `
    <template v-if="needLogin">
      <LoginGate @login-ok="needLogin=false; store.refreshNsOptions()"/>
      <ToastHost/>
    </template>
    <template v-else-if="loaded">
      <aside class="sidebar">
        <div class="brand"><span class="logo-mark">K</span> KubeStack</div>
        <nav>
          <div v-for="g in nav" :key="g.key" class="navgroup">
            <div class="navgroup-title"><i>{{ g.icon }}</i> {{ g.label }}</div>
            <a v-for="r in routes.filter(x=>x.group===g.key)" :key="r.path"
               :href="'#' + r.path.slice(1)" class="navlink"
               :class="{active: routePath===r.path}">{{ r.label }}</a>
          </div>
        </nav>
        <div class="sidebar-foot muted">开源 · Go + Vue</div>
      </aside>

      <main class="mainarea">
        <header class="topbar">
          <div class="crumb">
            <span class="crumb-current">{{ current.label }}</span>
          </div>
          <div class="topbar-right">
            <select class="input sel ns-select" :value="store.namespace" @change="switchNS"
                    title="当前项目（命名空间）作用域，影响工作负载/配置/网络等页面列表范围">
              <option value="_all">全部命名空间</option>
              <option v-for="n in store.nsOptions.filter(x=>x!=='_all')" :key="n" :value="n">{{ n }}</option>
            </select>
            <span class="muted small" v-if="store.version">{{ store.version.kubernetes }}</span>
            <button v-if="store.version && store.version.authEnabled" class="mini-btn" @click="logout">退出登录</button>
          </div>
        </header>

        <div class="content">
          <component :is="current.view"/>
        </div>
      </main>
      <ToastHost/>
    </template>
    <div v-else class="boot-loading">正在连接集群…</div>`,
  };

  const appInstance = createApp(AppRoot);
  // register shared components globally: ResTable embeds ResDrawer by name and
  // both load in separate files, so resolution must happen at mount time.
  [
    ['Badge', window.Badge], ['Modal', window.Modal], ['Drawer', window.Drawer],
    ['PageTabs', window.PageTabs], ['KVList', window.KVList], ['ProgressStat', window.ProgressStat],
    ['ResTable', window.ResTable], ['ResDrawer', window.ResDrawer],
    ['LogViewer', window.LogViewer], ['TerminalPane', window.TerminalPane],
  ].forEach(([name, comp]) => { if (comp) appInstance.component(name, comp); });
  appInstance.config.globalProperties.$toast = window.toast;
  appInstance.config.globalProperties.U = window.U;
  appInstance.mount('#app');
})();
