/* views_cluster.js — RBAC / storage / CRD & generic resource explorer */
(function () {
  const { ref, onMounted } = Vue;

  window.RbacView = {
    components: { ResTable: window.ResTable },
    setup() {
      const tab = ref('serviceaccounts');
      return { tab };
    },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[
        {key:'serviceaccounts',label:'服务账号'},
        {key:'roles',label:'角色'},
        {key:'rolebindings',label:'角色绑定'},
        {key:'clusterroles',label:'集群角色'},
        {key:'clusterrolebindings',label:'集群角色绑定'}]"/>
      <div style="margin-top:14px">
        <ResTable v-if="tab==='serviceaccounts'" key="sa" gvrPath="v1/serviceaccounts" label="ServiceAccount"/>
        <ResTable v-if="tab==='roles'" key="ro" gvrPath="rbac.authorization.k8s.io/v1/roles" label="Role"/>
        <ResTable v-if="tab==='rolebindings'" key="rb" gvrPath="rbac.authorization.k8s.io/v1/rolebindings" label="RoleBinding"/>
        <ResTable v-if="tab==='clusterroles'" key="cr" gvrPath="rbac.authorization.k8s.io/v1/clusterroles" :namespaced="false" label="ClusterRole"/>
        <ResTable v-if="tab==='clusterrolebindings'" key="crb" gvrPath="rbac.authorization.k8s.io/v1/clusterrolebindings" :namespaced="false" label="ClusterRoleBinding"/>
      </div>
    </div>`,
  };

  window.StorageView = {
    components: { ResTable: window.ResTable, PageTabs: window.PageTabs },
    setup() {
      const tab = ref('pvc');
      return { tab };
    },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[
        {key:'pvc',label:'存储声明 PVC'},
        {key:'pv',label:'存储卷 PV'},
        {key:'sc',label:'存储类 StorageClass'}]"/>
      <div style="margin-top:14px">
        <ResTable v-if="tab==='pvc'" key="pvc" gvrPath="v1/persistentvolumeclaims" label="PVC">
          <template #cols><th>容量</th><th>存储类</th><th>模式</th></template>
          <template #cells="{row}">
            <td>{{ row.status?.capacity?.storage || '-' }}</td>
            <td>{{ row.spec.storageClassName || '-' }}</td>
            <td>{{ row.spec.accessModes?.join(',') || '-' }}</td>
          </template>
        </ResTable>
        <ResTable v-if="tab==='pv'" key="pv" gvrPath="v1/persistentvolumes" :namespaced="false" label="PV">
          <template #cols><th>容量</th><th>状态</th><th>回收策略</th></template>
          <template #cells="{row}">
            <td>{{ row.spec.capacity?.storage || '-' }}</td>
            <td>{{ row.status.phase }}</td>
            <td>{{ row.spec.persistentVolumeReclaimPolicy }}</td>
          </template>
        </ResTable>
        <ResTable v-if="tab==='sc'" key="sc" gvrPath="storage.k8s.io/v1/storageclasses" :namespaced="false" label="StorageClass">
          <template #cols><th>供应者</th><th>回收策略</th><th>默认</th></template>
          <template #cells="{row}">
            <td>{{ row.provisioner }}</td>
            <td>{{ row.reclaimPolicy || '-' }}</td>
            <td>{{ (row.metadata.annotations||{})['storageclass.kubernetes.io/is-default-class'] === 'true' ? '是' : '否' }}</td>
          </template>
        </ResTable>
      </div>
    </div>`,
  };

  /* CRD list + generic explorer over the whole discovery catalog */
  window.CrdExplorerView = {
    components: { ResTable: window.ResTable, Drawer: window.Drawer, KVList: window.KVList, PageTabs: window.PageTabs },
    setup() {
      const tab = ref('explore');
      const catalog = ref([]);
      const gvIndex = ref({});
      const sel = Vue.reactive({ apiVersion: '', resource: '', namespaced: true });
      const crdDrawer = ref(null);

      async function loadCatalog() {
        const r = await API.get('/api/resources');
        catalog.value = r.resources || [];
        const idx = {};
        for (const c of catalog.value) (idx[c.apiVersion] = idx[c.apiVersion] || []).push(c);
        gvIndex.value = idx;
        if (!sel.apiVersion) {
          sel.apiVersion = 'apps/v1';
          sel.resource = 'deployments';
          sel.namespaced = true;
        }
      }
      onMounted(loadCatalog);
      function pick() {
        const opts = gvIndex.value[sel.apiVersion] || [];
        const found = opts.find((o) => o.resource === sel.resource);
        sel.namespaced = found ? found.namespaced : true;
      }
      const path = computed(() => {
        return sel.apiVersion.includes('/') ? `${sel.apiVersion}/${sel.resource}` : `/${sel.apiVersion}/${sel.resource}`;
      });
      return { tab, catalog, gvIndex, sel, pick, path, crdDrawer, U };
    },
    template: `
    <div>
      <PageTabs v-model="tab" :tabs="[{key:'explore',label:'资源浏览器'},{key:'crds',label:'CRD 定义'}]"/>
      <div style="margin-top:14px">
        <div v-if="tab==='explore'">
          <div class="card pad toolbar-row">
            <select class="input sel grow" v-model="sel.apiVersion" @change="pick()">
              <option disabled value="">选择 apiVersion…</option>
              <option v-for="(opts,gv) in gvIndex" :key="gv" :value="gv">{{ gv }}</option>
            </select>
            <select class="input sel grow" v-model="sel.resource" @change="pick()">
              <option disabled value="">选择资源类型…</option>
              <option v-for="o in (gvIndex[sel.apiVersion]||[])" :key="o.resource" :value="o.resource">
                {{ o.kind }}（{{ o.resource }}）</option>
            </select>
            <span class="muted">{{ sel.namespaced ? '命名空间级资源' : '集群级资源' }}</span>
          </div>
          <div style="margin-top:14px" v-if="sel.resource">
            <ResTable :key="path + ':' + store.namespace"
              :gvr-path="path.startsWith('/') ? path.slice(1) : path"
              :namespaced="sel.namespaced" label="自定义资源"/>
          </div>
        </div>

        <template v-if="tab==='crds'">
          <ResTable gvr-path="apiextensions.k8s.io/v1/customresourcedefinitions"
                    :namespaced="false" label="CRD" @detail="c => crdDrawer = c">
            <template #cols><th>范围</th><th>版本(存储)</th><th>分组</th></template>
            <template #cells="{row}">
              <td>{{ row.spec.scope === 'Namespaced' ? '命名空间' : '集群' }}</td>
              <td>{{ row.status?.storedVersions?.join(',') || '-' }}</td>
              <td>{{ row.spec.group }}</td>
            </template>
          </ResTable>
        </template>
      </div>
      <Drawer v-if="crdDrawer" width="760px" :title="crdDrawer.metadata.name" @close="crdDrawer=null;tab='crds'">
        <KVList :items="[
          {k:'Kind', v:(crdDrawer.spec.names||{}).kind},
          {k:'复数名', v:(crdDrawer.spec.names||{}).plural},
          {k:'范围', v:crdDrawer.spec.scope},
          {k:'分组', v:crdDrawer.spec.group},
          {k:'已接受版本', v:(crdDrawer.status||{}).acceptedNames && (crdDrawer.status.acceptedNames.plural)},
          {k:'创建时间', v:U.age(crdDrawer.metadata.creationTimestamp)}]"/>
      </Drawer>
    </div>`,
  };
})();
