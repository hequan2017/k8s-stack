/* views_tools.js — YAML apply center */
(function () {
  const { ref } = Vue;

  const SAMPLE = `# 在线编辑后点击“应用”，支持多文档(---分隔)，语义等同 kubectl apply
apiVersion: v1
kind: Namespace
metadata:
  name: kubestack-demo
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-nginx
  namespace: kubestack-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-nginx
  template:
    metadata:
      labels:
        app: demo-nginx
    spec:
      containers:
        - name: nginx
          image: docker.m.daocloud.io/library/nginx:1.27-alpine
`;

  window.YamlApplyView = {
    setup() {
      const manifest = ref(SAMPLE);
      const results = ref([]);
      const running = ref(false);
      async function apply() {
        running.value = true;
        try {
          const r = await API.post('/api/apply', { manifest: manifest.value });
          results.value = r.results || [];
          toast('应用完成');
          window.bus.emit('refresh-all');
        } catch (e) { toast(e.message, 'error'); }
        running.value = false;
      }
      function fmtSample() { manifest.value = SAMPLE; }
      return { manifest, results, running, apply, fmtSample };
    },
    template: `
    <div>
      <div class="view-toolbar">
        <button class="btn primary" :disabled="running" @click="apply">{{ running?'应用中…':'保存并应用' }}</button>
        <button class="btn ghost" @click="fmtSample">示例</button>
      </div>
      <textarea class="code-editor tall card" v-model="manifest" spellcheck="false"></textarea>

      <div class="card pad" style="margin-top:14px" v-if="results.length">
        <h4>应用结果</h4>
        <table class="tbl simple">
          <thead><tr><th>资源</th><th>动作</th><th>状态</th><th>信息</th></tr></thead>
          <tbody>
            <tr v-for="(r,i) in results" :key="i">
              <td class="mono">{{ r.target }}</td>
              <td>{{ r.action || '-' }}</td>
              <td><span :class="r.ok ? 'text-ok' : 'text-bad'">{{ r.ok ? '成功' : '失败' }}</span></td>
              <td class="wrap mono small">{{ r.ok ? '' : r.error }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,
  };
})();
