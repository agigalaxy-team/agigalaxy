export function createDataExportMenu({ controller, select, prompt, info, language, isCurrent, onBack }) {
  const zh = language !== 'en-US', label = (a, b) => zh ? a : b;
  let generation = 0, ticket;
  const back = () => { generation++; controller.cancel(); onBack(); };
  async function run(work, done) {
    const version = ++generation;
    info(label('导出本人资料', 'Export my data'), label('正在处理；返回可取消下载。', 'Working; go back to cancel download.'), back);
    try { const result = await work(); if (version === generation && isCurrent()) done(result); }
    catch (error) { if (version === generation && isCurrent()) info(label('导出未完成', 'Export incomplete'), String(error.message).slice(0, 700), home); }
  }
  function save() {
    let submitted = false;
    prompt({ title: label('输入本机现有目录的绝对路径；将在其中新建导出文件夹', 'Existing absolute local directory; a new export folder will be created'), placeholder: '',
      onCancel: home, onConfirm: value => { if (isCurrent() && !submitted) { submitted = true; void run(() => controller.saveDataExport(ticket.id, String(value).trim()), result =>
        info(label('导出完成', 'Export complete'), `${result.directory}\n${result.files} ${label('个文件', 'files')} · ${result.totalRows} ${label('条记录', 'records')}`, home)); } } });
  }
  function ready(value) {
    ticket = value;
    select({ title: `${ticket.views?.length ? label('授权内容导出', 'Authorized view export') : label('本人数据导出', 'Own-data export')}\n${ticket.endpoint}\n${ticket.subjectId}\n${label('到期', 'Expires')}: ${new Date(ticket.expiresAt * 1000).toISOString()}`,
      options: [{ number: '1', title: label('保存全部所选数据到本机', 'Save selected data locally'), description: label('NDJSON与摘要清单；包含私有记录，请自行保管', 'NDJSON and manifest; includes private records') },
        { number: '2', title: label('取消此下载记录', 'Revoke this download'), description: '' }],
      routes: { 1: save, 2: () => void run(() => controller.readDataExport('revoke', { id: ticket.id }), () => { ticket = null; home(); }) }, onBack: home });
  }
  function chooseView(kinds) {
    const names = { assistance: ['协作请求', 'Assistance'], context: ['共享材料', 'Context'], proof: ['Proof', 'Proof'],
      capsule: ['Capsule', 'Capsule'], builder: ['建设者登记', 'Builder'], moderation: ['治理记录', 'Moderation'] };
    const routes = {};
    const options = kinds.map((kind, index) => {
      routes[index + 1] = () => {
        let submitted = false;
        prompt({ title: label('输入当前可查看记录的 ID', 'Enter the ID of a currently readable record'), placeholder: '', onCancel: home,
          onConfirm: value => {
            if (!isCurrent() || submitted) return; submitted = true;
            void run(() => controller.readDataExport('create', { datasets: ['authorized-views'], views: [{ kind, id: String(value).trim() }] }), ready);
          } });
      };
      return { number: String(index + 1), title: label(...names[kind]), description: label('按当前读取权限保存，不增加转发权限', 'Save with current read permission; no additional sharing rights') };
    });
    select({ title: label('选择内容类型', 'Choose content type'), options, routes, onBack: home });
  }
  function home() {
    if (!isCurrent()) return;
    void run(() => controller.readDataExport('specification'), specification => select({ title: label('导出本人资料', 'Export my data'),
      options: [{ number: '1', title: label('创建10分钟下载记录', 'Create10-minute download'), description: `${specification.datasets.length} ${label('类本人数据；原Proof仅作历史副本', 'own datasets; Proofs are historical copies')}` },
        ...(specification.viewKinds?.length ? [{ number: '2', title: label('导出当前有权查看的内容', 'Export currently readable content'), description: label('按记录 ID 选择协作、材料等内容', 'Select assistance, context or other content by record ID') }] : [])],
      routes: { 1: () => void run(() => controller.readDataExport('create', { datasets: specification.datasets }), ready),
        2: () => chooseView(specification.viewKinds) }, onBack: back }));
  }
  return { open: home };
}
