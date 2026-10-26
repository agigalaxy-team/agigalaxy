import { createBuildersPublishing } from './builders/publishing.mjs';
import { createBuildersCatalog } from './builders/catalog.mjs';
import { createBuildersManagement } from './builders/management.mjs';
import { showExactChoice } from './exact-choice.mjs';
export function createBuilderMenu({
  controller,
  select,
  prompt,
  info,
  language,
  isCurrent,
  onBack,
  onReturnWork = onBack,
  availableScopes = null,
}) {
  const zh = language !== 'en-US',
    label = (a, b) => (zh ? a : b),
    has = (s) => !availableScopes || availableScopes.includes(s);
  const plain = (v, max = 1200) =>
    String(v ?? '')
      .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .slice(0, max);
  const split = (s) =>
    String(s ?? '')
      .split(/[,，;；]/)
      .map((v) => v.trim())
      .filter(Boolean);
  const stateName = (state) =>
    ({
      registered: label('已有登记', 'Registered'),
      delisted: label('已从目录下架', 'Delisted'),
      unverified: label('尚无兼容结果', 'No conformance result'),
      'reported-pass': label(
        '兼容报告所列检查通过',
        'Reported compatibility checks passed',
      ),
      'reported-fail': label(
        '兼容报告有失败项',
        'Reported compatibility checks failed',
      ),
      incomplete: label(
        '兼容报告范围不完整',
        'Compatibility report is incomplete',
      ),
      current: label('当前可读', 'Currently readable'),
      expired: label('已过期', 'Expired'),
      revoked: label('已撤销', 'Revoked'),
      unknown: label('尚无运行状态记录', 'No running status record'),
      'recent-owner-heartbeat': label(
        '所有者最近已报到',
        'Recent owner heartbeat',
      ),
      unobserved: label('尚无可达性观察', 'No reachability observation'),
      reachable: label('最近观察到可达', 'Observed reachable'),
      unreachable: label('最近观察到不可达', 'Observed unreachable'),
    })[state] ?? plain(state);
  let generation = 0,
    viewGeneration = 0,
    query = '';
  const leave = () => {
    generation++;
    controller.cancel();
    onBack();
  };
  const message = (text, back = home) => {
    if (isCurrent()) {
      const view = ++viewGeneration;
      info(label('开放节点', 'Open node'), text, () => {
        if (isCurrent() && view === viewGeneration) {
          viewGeneration++;
          back();
        }
      });
    }
  };
  const returnWork = () => {
    generation++;
    viewGeneration++;
    controller.cancel();
    onReturnWork();
  };
  function menu(title, entries, back = home, offset = 0) {
    if (!isCurrent()) return;
    const routes = {},
      view = ++viewGeneration;
    const options = entries
      .slice(offset, offset + 8)
      .map(([title, action, description = ''], i) => {
        routes[i + 1] = () => {
          if (isCurrent() && view === viewGeneration) {
            viewGeneration++;
            action();
          }
        };
        return { number: String(i + 1), title, description };
      });
    if (offset + 8 < entries.length) {
      options.push({
        number: '9',
        title: label('下一页', 'Next page'),
        description: '',
      });
      routes[9] = () => {
        if (isCurrent() && view === viewGeneration)
          menu(title, entries, back, offset + 8);
      };
    }
    select({
      title,
      options,
      routes,
      onBack: () => {
        if (isCurrent() && view === viewGeneration) {
          viewGeneration++;
          if (offset) menu(title, entries, back, offset - 8);
          else back();
        }
      },
    });
  }
  async function run(work, done, back = home) {
    const version = ++generation;
    message(label('正在读取或准备', 'Reading or preparing'), () => {
      generation++;
      controller.cancel();
      back();
    });
    try {
      const result = await work();
      if (isCurrent() && generation === version) done(result);
    } catch (error) {
      if (isCurrent() && generation === version)
        message(plain(error.message), back);
    }
  }
  function form(title, fields, done, back = home, draft = {}, index = 0) {
    if (!isCurrent()) return;
    if (index === fields.length) return done(draft);
    const [key, name, initial = '', maximum = 1200] = fields[index],
      view = ++viewGeneration;
    prompt({
      title: `${title} · ${index + 1}/${fields.length}\n${name}`,
      value: String(draft[key] ?? initial),
      placeholder: '',
      onCancel: () => {
        if (isCurrent() && view === viewGeneration) {
          viewGeneration++;
          if (index) form(title, fields, done, back, draft, index - 1);
          else back();
        }
      },
      onConfirm: (value) => {
        if (!isCurrent() || view !== viewGeneration) return;
        viewGeneration++;
        if (String(value).length > maximum)
          return message(label('内容超长', 'Content is too long'), () =>
            form(title, fields, done, back, draft, index),
          );
        draft[key] = String(value).trim();
        form(title, fields, done, back, draft, index + 1);
      },
    });
  }
  function confirm(input, back) {
    confirmPrepared(() => controller.prepareBuilder(input), back);
  }
  function confirmPrepared(
    work,
    back,
    {
      execute = controller.executeBuilder,
      proof = false,
      note = '',
      title = '',
      allowLabel = '',
    } = {},
  ) {
    void run(
      work,
      (preview) => {
        const cancel = () => {
          generation++;
          controller.cancel();
          back();
        };
        let submitted = false;
        const show = () => {
          const view = ++viewGeneration;
          showExactChoice({
            preview,
            title:
              title ||
              (proof
                ? label('保存节点授权证明', 'Save node authorization proof')
                : label('保存这份开放节点内容', 'Save this open node content')),
            allowLabel,
            select,
            info,
            language,
            note,
            readBeforeChoice: true,
            isCurrent: () =>
              isCurrent() && view === viewGeneration && !submitted,
            onCancel: () => {
              if (isCurrent() && view === viewGeneration) {
                viewGeneration++;
                cancel();
              }
            },
            onConfirm: async (value) => {
              if (!isCurrent() || submitted || view !== viewGeneration) return;
              viewGeneration++;
              submitted = true;
              const version = ++generation;
              message(label('正在提交', 'Submitting'), cancel);
              try {
                const receipt = await execute(preview, value);
                if (isCurrent() && generation === version)
                  message(
                    proof
                      ? `${label('已生成本机授权证明', 'Local authorization proof saved')}: ${plain(receipt.path)}\n${label('离线签名不能说明之后的撤销；不代表能力或端点控制权。', 'Offline signatures cannot establish later revocation; no capability or endpoint control conclusion.')}`
                      : label(
                          '已记录这次内容，可以继续原工作。',
                          'This content is recorded. Continue the original work.',
                        ),
                    back,
                  );
              } catch {
                if (isCurrent() && generation === version)
                  message(
                    label(
                      '结果未确认，请先读取记录后再决定是否重试',
                      'Outcome unconfirmed; read existing records before retrying',
                    ),
                    back,
                  );
              }
            },
          });
        };
        show();
      },
      back,
    );
  }
  function home() {
    menu(
      label('Galaxy / 建设者', 'Galaxy / Builders'),
      [
        [
          label('浏览目录', 'Browse directory'),
          () =>
            menu(
              label('登记类型', 'Builder type'),
              ['worker', 'bridge', 'hub'].map((type) => [
                type,
                () => listing(type),
              ]),
            ),
        ],
        [
          label('搜索目录', 'Search directory'),
          () =>
            form(
              'Builders',
              [
                [
                  'query',
                  label('名称或适用范围中的文字', 'Text in name or scope'),
                  query,
                  200,
                ],
              ],
              (v) => {
                query = v.query;
                listing();
              },
            ),
        ],
        [
          label('按ID打开', 'Open by ID'),
          () =>
            form('Builders', [['builderId', 'Builder ID', '', 36]], (v) =>
              detail(v.builderId),
            ),
        ],
        ...(controller.prepareBuilder && has('consent')
          ? [
              [
                label('新建登记', 'Register builder'),
                () =>
                  menu(
                    label('登记类型', 'Builder type'),
                    ['worker', 'bridge', 'hub'].map((type) => [
                      type,
                      () => publish(type),
                    ]),
                  ),
              ],
            ]
          : []),
        ...(controller.queryOwnedBuilders
          ? [[label('管理我的登记', 'Manage my registrations'), () => owned()]]
          : []),
        ...(controller.queryBuilderNotices
          ? [
              [
                label('按ID查看维护公告', 'Read notices by ID'),
                () =>
                  form(
                    'Builder',
                    [['builderId', 'Builder ID', '', 36]],
                    (value) => notices(value.builderId),
                  ),
              ],
            ]
          : []),
        ...(controller.listBuilderOperations
          ? [[label('本机建设者待办', 'Local Builder operations'), operations]]
          : []),
        [label('回到原工作', 'Return to original work'), returnWork],
      ],
      leave,
    );
  }
  const session = {
    get checks() {
      return checks;
    },
    get confirm() {
      return confirm;
    },
    get confirmPrepared() {
      return confirmPrepared;
    },
    get controller() {
      return controller;
    },
    get detail() {
      return detail;
    },
    get disclosure() {
      return disclosure;
    },
    get form() {
      return form;
    },
    get has() {
      return has;
    },
    get home() {
      return home;
    },
    get label() {
      return label;
    },
    get management() {
      return management;
    },
    get menu() {
      return menu;
    },
    get message() {
      return message;
    },
    get parseRows() {
      return parseRows;
    },
    get plain() {
      return plain;
    },
    get publish() {
      return publish;
    },
    get query() {
      return query;
    },
    set query(value) {
      query = value;
    },
    get returnWork() {
      return returnWork;
    },
    get run() {
      return run;
    },
    get split() {
      return split;
    },
    get stateName() {
      return stateName;
    },
  };
  const { parseRows, checks, disclosure, publish } =
    createBuildersPublishing(session);
  const { detail, listing } = createBuildersCatalog(session);
  const { notices, management, owned, operations } =
    createBuildersManagement(session);
  return Object.freeze({ open: home, openBuilder: detail });
}
