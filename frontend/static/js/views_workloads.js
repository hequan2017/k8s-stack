/* views_workloads.js — workloads tabs + pods view (KubeSphere-style project resources) */
(function () {
  const { ref } = Vue;

  /* deployments/statefulsets/ds/rs/jobs/cronjobs share one wrapper */
  function workloadTab(kindPlural, isJobFamily) {
    return {
      components: { ResTable: window.ResTable, ResDrawer: window.ResDrawer },
      props: {},
      setup() {
        const drawerItem = ref(null);
        return { drawerItem };
      },
      template: `
      <ResTable gvr-path="${kindPlural}" label="${kindPlural}"
                @detail="r => drawerItem = r">
        <template #cols>
          ${isJobFamily
            ? '<th>完成度</th><th>镜像</th>'
            : '<th>副本就绪</th><th>镜像</th>'}
        </template>
        <template #cells="{row}">
          ${isJobFamily
            ? `<td>{{ (row.spec.completions || '-') + '/' + (row.status.succeeded || 0) }}</td>`
            : `<td>{{ ((row.status.readyReplicas || (row.status.numberReady ?? 0)) ?? 0) + '/' + ((row.spec.replicas ?? row.status.desiredNumberScheduled ?? '-') ) }}</td>`}
          <td class="mono wrap">{{ (row.spec.template?.spec?.containers || [{}])[0].image || '-' }}</td>
        </template>
      </ResTable>
      <ResDrawer v-if="drawerItem" gvr-path="${kindPlural}" :namespaced="true"
                 :item="drawerItem" @close="drawerItem=null"/>
      `,
    };
  }

  window.WorkloadsView = {
    components: {
      PageTabs: window.PageTabs,
      DeploymentsTab: workloadTab('apps/v1/deployments'),
      StatefulSetsTab: workloadTab('apps/v1/statefulsets'),
      DaemonSetsTab: workloadTab('apps/v1/daemonsets'),
      ReplicaSetsTab: workloadTab('apps/v1/replicasets'),
      JobsTab: workloadTab('batch/v1/jobs', true),
      CronJobsTab: workloadTab('batch/v1/cronjobs', true),
      HpaTab: workloadTab('autoscaling/v2/horizontalpodautoscalers'),
    },
    setup() { const tab = ref('deployments'); return { tab }; },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[
        {key:'deployments',label:'部署'},
        {key:'statefulsets',label:'有状态副本集'},
        {key:'daemonsets',label:'守护进程集'},
        {key:'replicasets',label:'副本集'},
        {key:'jobs',label:'任务'},
        {key:'cronjobs',label:'定时任务'},
        {key:'hpa',label:'弹性伸缩 HPA'}]"/>
      <div style="margin-top:14px">
        <DeploymentsTab v-if="tab==='deployments'"/>
        <StatefulSetsTab v-else-if="tab==='statefulsets'"/>
        <DaemonSetsTab v-else-if="tab==='daemonsets'"/>
        <ReplicaSetsTab v-else-if="tab==='replicasets'"/>
        <JobsTab v-else-if="tab==='jobs'"/>
        <CronJobsTab v-else-if="tab==='cronjobs'"/>
        <HpaTab v-else-if="tab==='hpa'"/>
      </div>
    </div>`,
    methods: {
      // nothing extra; tabs mount on demand
    },
  };

  window.PodsView = {
    components: { ResTable: window.ResTable, ResDrawer: window.ResDrawer },
    setup() {
      const drawerItem = ref(null);
      return { drawerItem, U };
    },
    template: `
    <div>
      <ResTable gvr-path="v1/pods" label="容器组" @detail="r => drawerItem = r">
        <template #cols><th>状态</th><th>重启次数</th><th>节点</th><th>IP</th><th>镜像</th></template>
        <template #cells="{row}">
          <td><span class="badge" :class="'badge-'+U.podStatusColor(row)"><i class="dot"></i>{{ U.podStatusText(row) }}</span></td>
          <td>{{ (row.status.containerStatuses||[]).reduce((a,c)=>a+(c.restartCount||0),0) }}</td>
          <td>{{ row.spec.nodeName || '-' }}</td>
          <td class="mono">{{ row.status.podIP || '-' }}</td>
          <td class="mono wrap">{{ (row.spec.containers||[{}])[0].image }}</td>
        </template>
      </ResTable>
      <ResDrawer v-if="drawerItem" gvr-path="v1/pods" :namespaced="true"
                 :item="drawerItem" @close="drawerItem=null"/>
    </div>`,
  };

  /* ============== network & config pages ============== */
  window.NetworkView = {
    components: { ResTable: window.ResTable, PageTabs: window.PageTabs },
    setup() { const tab = ref('services'); return { tab }; },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[
        {key:'services',label:'服务 Service'},
        {key:'ingresses',label:'路由 Ingress'},
        {key:'endpoints',label:'端点 Endpoints'}]"/>
      <div style="margin-top:14px">
        <ResTable v-if="tab==='services'" key="svc" gvr-path="v1/services" label="Services">
          <template #cols><th>类型</th><th>ClusterIP</th><th>端口</th><th>外部端口</th></template>
          <template #cells="{row}">
            <td>{{ row.spec.type }}</td>
            <td class="mono">{{ row.spec.clusterIP || '-' }}</td>
            <td class="mono">{{ (row.spec.ports||[]).map(p=>p.port+'/'+p.protocol).join(', ') }}</td>
            <td class="mono">{{ (row.spec.ports||[]).map(p=>p.nodePort).filter(Boolean).join(', ') || '-' }}</td>
          </template>
        </ResTable>
        <ResTable v-if="tab==='ingresses'" key="ing" gvr-path="networking.k8s.io/v1/ingresses" label="Ingresses">
          <template #cols><th>主机</th><th>路径规则</th></template>
          <template #cells="{row}">
            <td class="mono">{{ (row.spec.rules||[]).map(r=>r.host).join(', ') || '*' }}</td>
            <td class="wrap mono">{{ (row.spec.rules||[]).flatMap(r=>((r.http&&r.http.paths)||[]).map(p=>p.path+' → '+(p.backend.service? p.backend.service.name+':'+(p.backend.service.port&&p.backend.service.port.number):'-'))).join('; ') || '-' }}</td>
          </template>
        </ResTable>
        <ResTable v-if="tab==='endpoints'" key="ep" gvr-path="discovery.k8s.io/v1/endpointslices" label="EndpointSlices">
          <template #cols><th>服务</th><th>地址</th><th>端口</th></template>
          <template #cells="{row}">
            <td>{{ row.metadata.labels?.['kubernetes.io/service-name'] || '-' }}</td>
            <td class="mono">{{ (row.endpoints||[]).slice(0,4).map(e=>e.addresses?.[0]).filter(Boolean).join(', ') }}{{ (row.endpoints||[]).length>4?' …':'' }}</td>
            <td class="mono">{{ (row.endpoints||[])[0]?.targetRef?.kind || '' }} {{ (row.ports||[]).map(p=>p.port).join(',') }}</td>
          </template>
        </ResTable>
      </div>
    </div>`,
  };

  window.ConfigView = {
    components: { ResTable: window.ResTable, PageTabs: window.PageTabs },
    setup() { const tab = ref('configmaps'); return { tab }; },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[
        {key:'configmaps',label:'配置字典 ConfigMap'},
        {key:'secrets',label:'保密字典 Secret'}]"/>
      <div style="margin-top:14px">
        <ResTable v-if="tab==='configmaps'" key="cm" gvr-path="v1/configmaps" label="ConfigMap">
          <template #cols><th>数据项</th></template>
          <template #cells="{row}"><td>{{ Object.keys(row.data||{}).length }}</td></template>
        </ResTable>
        <ResTable v-if="tab==='secrets'" key="sec" gvr-path="v1/secrets" label="Secret">
          <template #cols><th>类型</th><th>数据项</th></template>
          <template #cells="{row}">
            <td>{{ row.type }}</td>
            <td>{{ Object.keys(row.data||{}).length }}</td>
          </template>
        </ResTable>
      </div>
    </div>`,
  };
})();
