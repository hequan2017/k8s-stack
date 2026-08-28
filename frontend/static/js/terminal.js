/* terminal.js — LogViewer (streaming) + TerminalPane (websocket exec over xterm) */
(function () {
  /* ---------------- streaming log viewer ---------------- */
  window.LogViewer = {
    props: ['namespace', 'podname'],
    data() {
      return {
        containers: [],
        container: '',
        lines: [],
        following: true,
        tailLines: 500,
        streaming: false,
        controller: null,
        stateMsg: '',
      };
    },
    async mounted() {
      try {
        const pod = await API.get('/api/res/v1/pods/' + this.namespace + '/' + this.podname);
        this.containers = [
          ...(pod.spec?.initContainers || []).map((c) => ({ ...c, _init: true })),
          ...(pod.spec?.containers || []),
        ];
        if (this.containers.length) {
          this.container = this.containers[0].name;
          this.start();
        } else {
          this.stateMsg = '该容器组没有可读容器';
        }
      } catch (e) {
        this.stateMsg = '加载失败: ' + e.message;
        if (window.toast) window.toast('日志加载失败: ' + e.message, 'error');
      }
    },
    unmounted() { this.stop(); },
    methods: {
      stop() {
        this.streaming = false;
        if (this.controller) { try { this.controller.abort(); } catch (e) {} }
      },
      start() {
        this.stop();
        this.lines = [];
        this.streaming = true;
        const ctl = new AbortController();
        this.controller = ctl;
        this.pump(ctl);
      },
      async pump(ctl) {
        let buffer = '';
        try {
          const headers = {};
          const token = API.token();
          if (token) headers.Authorization = 'Bearer ' + token;
          const url = `/api/pods/${this.namespace}/${this.podname}/log/stream?container=${encodeURIComponent(this.container)}&tail=${this.tailLines}&follow=true`;
          this.stateMsg = '连接中…';
          const resp = await fetch(url, { headers, signal: ctl.signal });
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          this.stateMsg = '跟随中…';
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += dec.decode(value, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop();
            for (const line of parts) this.push(line);
          }
          if (buffer) this.push(buffer);
        } catch (e) {
          if (!ctl.signal.aborted && this.streaming) {
            this.push('[日志流断开: ' + e.message + ']');
            this.stateMsg = '错误: ' + e.message;
          }
        }
        this.streaming = false;
      },
      push(line) {
        this.lines.push(line);
        if (this.lines.length > 3000) this.lines.splice(0, this.lines.length - 3000);
        if (this.following) this.$nextTick(() => {
          const el = this.$refs.logbox;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },
    },
    template: `
    <div class="logviewer">
      <div class="log-toolbar">
        <select class="input sel" v-model="container" @change="start()">
          <option v-for="c in containers" :key="c.name" :value="c.name">
            {{ c.name }}{{ c._init ? '（init）' : '' }}
          </option>
        </select>
        <label class="chk"><input type="checkbox" v-model="following"/> 自动滚动</label>
        <button class="mini-btn" :disabled="streaming" @click="start()">{{ streaming ? '跟随中…' : '重新获取' }}</button>
        <span class="muted" style="margin-left:auto">{{ stateMsg }} 共 {{ lines.length }} 行</span>
      </div>
      <pre class="logbox" ref="logbox">{{ lines.join('\\n') }}</pre>
    </div>`,
  };

  /* ---------------- interactive terminal (exec) ---------------- */
  window.TerminalPane = {
    props: { namespace: String, podname: String, initialContainer: String },
    data() {
      return { containers: [], container: '', term: null, ws: null, fit: null, connected: false };
    },
    async mounted() {
      try {
        const pod = await API.get('/api/res/v1/pods/' + this.namespace + '/' + this.podname);
        this.containers = [...(pod.spec?.initContainers || []).map((c)=>({...c,_init:true})), ...(pod.spec?.containers || [])];
      } catch (e) { this.$toast(e.message, 'error'); }
      this.container = this.initialContainer ||
        (this.containers.find((c) => !c._init) || {}).name || 'main';
      await this.$nextTick();
      this.initTerm();
      this.connect();
    },
    unmounted() { this.destroy(); },
    beforeUnmount() { this.destroy(); },
    methods: {
      initTerm() {
        const el = this.$refs.term;
        if (!el || !window.Terminal) return;
        const term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
          theme: { background: '#0d1117', foreground: '#e6edf3' },
          scrollback: 5000,
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(el);
        try { fit.fit(); } catch (e) {}
        term.onData((data) => {
          // raw text frames are stdin; only control messages use JSON
          if (this.ws && this.ws.readyState === 1) this.ws.send(data);
        });
        this.term = term; this.fit = fit;
        this.onResize = () => { try { fit.fit(); } catch (e) {} };
        window.addEventListener('resize', this.onResize);
      },
      destroy() {
        if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
        if (this.term) { try { this.term.dispose(); } catch (e) {} this.term = null; }
        if (this.onResize) window.removeEventListener('resize', this.onResize);
      },
      connect() {
        this.destroyWSOnly();
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        let url = `${proto}${location.host}/ws/exec/${this.namespace}/${this.podname}?container=${encodeURIComponent(this.container)}`;
        const token = API.token();
        if (token) url += '&token=' + encodeURIComponent(token);
        const ws = new WebSocket(url);
        this.ws = ws;
        this.connected = false;
        ws.onopen = () => { this.connected = true; this.sendResize(); this.term?.writeln('\r\n\x1b[36m● 会话已建立 ' + this.namespace + '/' + this.podname + '\x1b[0m'); };
        ws.onmessage = (ev) => {
          // JSON stdin/control frames never come back; server sends binary payload or text error
          if (typeof ev.data === 'string') { this.term?.write(ev.data); return; }
          ev.data.arrayBuffer().then((buf) => this.term?.write(new Uint8Array(buf)));
        };
        ws.onclose = () => { this.connected = false; this.term?.writeln('\r\n\x1b[33m○ 连接已关闭\x1b[0m'); };
        ws.onerror = () => { this.term?.writeln('\r\n\x1b[31m✕ 连接错误\x1b[0m'); };
      },
      destroyWSOnly() {
        if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
      },
      sendResize() {
        if (this.ws && this.ws.readyState === 1 && this.fit) {
          const dims = this.fit.proposeDimensions();
          if (dims && dims.cols > 0) {
            this.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
          }
        }
      },
      switchContainer() { this.connect(); },
    },
    template: `
    <div class="termpane">
      <div class="log-toolbar">
        <select class="input sel" v-model="container" @change="switchContainer()">
          <option v-for="c in containers" :key="c.name" :value="c.name">{{ c.name }}{{ c._init?'（init）':'' }}</option>
        </select>
        <span :class="['connstate', connected ? 'ok' : 'off']">{{ connected ? '已连接' : '未连接' }}</span>
        <button class="mini-btn" @click="connect()">重连</button>
      </div>
      <div ref="term" class="termbox"></div>
    </div>`,
  };
})();
