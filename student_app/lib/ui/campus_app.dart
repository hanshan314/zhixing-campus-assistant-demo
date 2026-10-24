import 'package:flutter/material.dart';
import '../controllers/app_controller.dart';
import '../domain/models.dart';
import 'components.dart';
import 'pending_operation_panel.dart';
import 'scenario_panel.dart';
import 'run_browser.dart';
import 'message_center.dart';
import 'style.dart';
import 'task_page.dart';

class CampusApp extends StatelessWidget {
  const CampusApp({super.key, required this.controller});
  final AppController controller;
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '知行 · 校园助理',
    debugShowCheckedModeBanner: false,
    theme: campusTheme(),
    home: CampusShell(controller: controller),
  );
}

class CampusShell extends StatefulWidget {
  const CampusShell({super.key, required this.controller});
  final AppController controller;
  @override
  State<CampusShell> createState() => _CampusShellState();
}

class _CampusShellState extends State<CampusShell> {
  int _tab = 0;
  String _filter = '全部';
  final _taskPageKey = GlobalKey<TaskPageState>();
  bool _leavingTask = false;
  AppController get c => widget.controller;

  Future<void> _leaveTask() async {
    if (_leavingTask || c.busy || c.task == null) return;
    final taskId = c.task!.id;
    final account = c.account;
    final epoch = c.sessionEpoch;
    setState(() => _leavingTask = true);
    try {
      final leave = await _taskPageKey.currentState?.requestLeave() ?? false;
      if (!mounted || !leave || c.busy) return;
      if (c.account == account && c.sessionEpoch == epoch && c.task?.id == taskId) {
        c.leaveTask();
      }
    } finally {
      if (mounted) setState(() => _leavingTask = false);
    }
  }

  Future<void> _switchAccount(String? account) async {
    if (c.pending != null) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('还有一项操作待核对'),
          content: const Text(
            '可以先查询原操作结果。退出或切换后，私人页面和草稿缓存会清理，未决操作按原账号隔离保留。只有重新选择原账号登录后，才能继续核对该操作；正式提交历史仍保留。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('暂不切换'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(account == null ? '仍然退出' : '仍然切换'),
            ),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }
    setState(() {
      _tab = 0;
      _filter = '全部';
    });
    if (account == null) {
      await c.logout();
    } else {
      await c.login(account);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) {
      final loggedIn = c.account != null && c.identity != null;
      final showingTask = loggedIn && c.task != null;
      return PopScope(
        canPop: !showingTask,
        onPopInvokedWithResult: (didPop, result) {
          if (!didPop && showingTask) _leaveTask();
        },
        child: Scaffold(
          body: SafeArea(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 720),
                child: Column(
                  children: [
                    const DemoBanner(),
                    if (loggedIn) _header(showingTask),
                    if (c.busy)
                      const LinearProgressIndicator(
                        minHeight: 2,
                        backgroundColor: paleTeal,
                      ),
                    Expanded(
                      child: !c.initialized
                          ? const Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  CircularProgressIndicator(),
                                  SizedBox(height: 18),
                                  Text('正在恢复演示会话…'),
                                ],
                              ),
                            )
                          : !loggedIn
                          ? _login()
                          : RefreshIndicator(
                              onRefresh: c.busy ? () async {} : c.refresh,
                              child: ListView(
                                key: ValueKey(
                                  showingTask
                                      ? 'task-${c.task!.id}'
                                      : 'tab-$_tab',
                                ),
                                padding: const EdgeInsets.fromLTRB(
                                  20,
                                  8,
                                  20,
                                  30,
                                ),
                                physics: const AlwaysScrollableScrollPhysics(),
                                keyboardDismissBehavior:
                                    ScrollViewKeyboardDismissBehavior.onDrag,
                                children: [
                                  if (c.error != null) ...[
                                    InfoBox(
                                      c.error!,
                                      title: '这一步还没有完成',
                                      warning: true,
                                    ),
                                    const SizedBox(height: 12),
                                  ],
                                  if (c.notice != null) ...[
                                    InfoBox(
                                      c.notice!,
                                      icon: Icons.check_circle_outline_rounded,
                                    ),
                                    const SizedBox(height: 12),
                                  ],
                                  if (!c.connected) ...[
                                    InfoBox(
                                      '本机演示服务尚未连接。启动服务后刷新即可继续，页面不会自动切换为假成功结果。',
                                      warning: true,
                                      action: OutlinedButton.icon(
                                        onPressed: c.busy ? null : c.refresh,
                                        icon: const Icon(
                                          Icons.refresh_rounded,
                                          size: 18,
                                        ),
                                        label: const Text('重新连接'),
                                      ),
                                    ),
                                    const SizedBox(height: 12),
                                  ],
                                  if (showingTask)
                                    TaskPage(key: _taskPageKey, controller: c)
                                  else if (_tab == 0)
                                    _assistant()
                                  else if (_tab == 1)
                                    _tasks()
                                  else if (_tab == 2)
                                    _discovery()
                                  else
                                    _profile(),
                                ],
                              ),
                            ),
                    ),
                    if (loggedIn && !showingTask)
                      NavigationBar(
                        selectedIndex: _tab,
                        onDestinationSelected: (index) =>
                            setState(() => _tab = index),
                        destinations: const [
                          NavigationDestination(
                            icon: Icon(Icons.auto_awesome_outlined),
                            selectedIcon: Icon(Icons.auto_awesome_rounded),
                            label: '助理',
                          ),
                          NavigationDestination(
                            icon: Icon(Icons.checklist_outlined),
                            selectedIcon: Icon(Icons.checklist_rounded),
                            label: '待办',
                          ),
                          NavigationDestination(
                            icon: Icon(Icons.explore_outlined),
                            selectedIcon: Icon(Icons.explore_rounded),
                            label: '发现',
                          ),
                          NavigationDestination(
                            icon: Icon(Icons.person_outline_rounded),
                            selectedIcon: Icon(Icons.person_rounded),
                            label: '我的',
                          ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
  );

  Widget _header(bool showingTask) => Padding(
    padding: EdgeInsets.fromLTRB(showingTask ? 6 : 22, 14, 14, 12),
    child: Row(
      children: [
        if (showingTask)
          IconButton(
            onPressed: c.busy || _leavingTask ? null : _leaveTask,
            tooltip: '返回',
            icon: const Icon(Icons.arrow_back_rounded),
          ),
        if (!showingTask) ...[
          Container(
            width: 35,
            height: 35,
            decoration: BoxDecoration(
              color: teal,
              borderRadius: BorderRadius.circular(11),
            ),
            child: const Icon(
              Icons.spa_outlined,
              color: Colors.white,
              size: 22,
            ),
          ),
          const SizedBox(width: 10),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                showingTask ? '任务详情' : '知行',
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  color: ink,
                ),
              ),
              if (!showingTask)
                const Text(
                  '你的校园事务助理',
                  style: TextStyle(fontSize: 11, color: mutedInk),
                ),
            ],
          ),
        ),
        SmallBadge(
          '账号 ${c.account?.toUpperCase() ?? ''}',
          color: mutedInk,
          background: const Color(0xFFEDF0EC),
        ),
        if (!showingTask) IconButton(
          onPressed: c.busy ? null : () => showMessageCenter(context, c),
          tooltip: '消息中心',
          icon: const Icon(Icons.notifications_none_rounded, color: mutedInk, size: 22),
        ),
        IconButton(
          onPressed: c.busy ? null : c.refresh,
          tooltip: '刷新当前记录',
          icon: const Icon(Icons.refresh_rounded, color: mutedInk, size: 22),
        ),
      ],
    ),
  );

  Widget _login() => ListView(
    padding: const EdgeInsets.fromLTRB(28, 38, 28, 30),
    children: [
      Align(
        alignment: Alignment.centerLeft,
        child: Container(
          width: 62,
          height: 62,
          decoration: BoxDecoration(
            color: teal,
            borderRadius: BorderRadius.circular(21),
          ),
          child: const Icon(Icons.spa_outlined, color: Colors.white, size: 36),
        ),
      ),
      const SizedBox(height: 30),
      Text('校园的事，\n从容一点。', style: Theme.of(context).textTheme.headlineLarge),
      const SizedBox(height: 14),
      const Text(
        '欢迎来到知行 · 校园助理\n接收任务，整理材料，随时找回办事进度。',
        style: TextStyle(fontSize: 15, height: 1.8, color: mutedInk),
      ),
      const SizedBox(height: 32),
      if (c.error != null) ...[
        InfoBox(c.error!, title: '暂时无法进入', warning: true),
        const SizedBox(height: 18),
      ],
      Panel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SmallBadge('本机演示体验', icon: Icons.science_outlined),
            const SizedBox(height: 18),
            Text(
              c.account == null ? '选择一个演示身份' : '重新验证演示身份',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            const Text(
              '两个账号姓名相同，但身份和材料分别保存。\n此处不是学校账号登录。',
              style: TextStyle(fontSize: 13, height: 1.6, color: mutedInk),
            ),
            const SizedBox(height: 24),
            _accountButton('a'),
            const SizedBox(height: 12),
            _accountButton('b'),
          ],
        ),
      ),
      const SizedBox(height: 22),
      const Text(
        '真实学校认证与 AI 对话尚未接通。\n站内消息、任务和材料仅使用隔离的虚拟样例。',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 12, color: mutedInk, height: 1.7),
      ),
    ],
  );

  Widget _accountButton(String account) => SizedBox(
    width: double.infinity,
    child: account == 'a'
        ? FilledButton.icon(
            onPressed: c.busy ? null : () => c.login(account),
            icon: const Icon(Icons.person_outline_rounded, size: 20),
            label: const Text('以虚拟学生甲 · A 进入'),
          )
        : OutlinedButton.icon(
            onPressed: c.busy ? null : () => c.login(account),
            icon: const Icon(Icons.person_outline_rounded, size: 20),
            label: const Text('以虚拟学生甲 · B 进入'),
          ),
  );

  List<CampusTask> get _pendingTasks => c.tasks
      .where(
        (task) => [
          'unread',
          'awaiting_confirmation',
          'awaiting_submission',
          'needs_revision',
        ].contains(task.status),
      )
      .toList();

  Widget _assistant() {
    final pending = _pendingTasks;
    final done = c.tasks
        .where((task) => ['approved', 'completed'].contains(task.status))
        .length;
    final date = DateTime.now().toUtc().add(const Duration(hours: 8));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: ink,
            borderRadius: BorderRadius.circular(26),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${date.month} 月 ${date.day} 日 · 今天也有条不紊',
                style: const TextStyle(color: Color(0xFFB8CFD0), fontSize: 12),
              ),
              const SizedBox(height: 20),
              Text(
                '你好，${c.identity?['display_name'] ?? '同学'}',
                style: const TextStyle(
                  fontSize: 24,
                  height: 1.35,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                pending.isEmpty
                    ? '已加载的任务里，暂时没有待处理事项。'
                    : '已加载任务中有 ${pending.length} 项待处理事务。',
                style: const TextStyle(
                  color: Color(0xFFD3E0E0),
                  fontSize: 14,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 24),
              Row(
                children: [
                  Expanded(
                    child: _metric('${pending.length}', '已加载待处理', Colors.white),
                  ),
                  Container(
                    width: 1,
                    height: 32,
                    color: const Color(0xFF385262),
                  ),
                  Expanded(
                    child: _metric('$done', '已加载已完成', const Color(0xFF9BDBC7)),
                  ),
                  Container(
                    width: 1,
                    height: 32,
                    color: const Color(0xFF385262),
                  ),
                  Expanded(
                    child: _metric('${c.tasks.length}', '已加载任务', Colors.white),
                  ),
                ],
              ),
            ],
          ),
        ),
        SectionHeading('从这里开始', subtitle: '直接进入可操作的事务'),
        Row(
          children: [
            Expanded(
              child: _shortcut(
                '查看待办',
                '要求与进度一目了然',
                Icons.checklist_rounded,
                () => setState(() {
                  _tab = 1;
                  _filter = '全部';
                }),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _shortcut(
                '待补正材料',
                '找到需要修改的版本',
                Icons.edit_note_rounded,
                () => setState(() {
                  _tab = 1;
                  _filter = '待补正';
                }),
                orange: true,
              ),
            ),
          ],
        ),
        SectionHeading(
          '待办速览',
          subtitle: '来自当前演示账号的已加载记录',
          trailing: TextButton(
            onPressed: () => setState(() => _tab = 1),
            child: const Text('查看全部'),
          ),
        ),
        if (pending.isEmpty)
          const EmptyState(
            title: '已加载任务暂无待办',
            message: '下拉刷新可以重新读取服务端记录。',
            icon: Icons.task_alt_rounded,
          )
        else
          ...pending
              .take(3)
              .map(
                (task) => TaskTile(
                  task: task,
                  enabled: !c.busy,
                  onTap: () => c.openTask(task.id),
                ),
              ),
        const SizedBox(height: 12),
        const InfoBox(
          '自然语言对话尚未接通。这里先呈现可核对的任务与操作入口，不会生成虚假的 AI 回复。',
          title: '助理正在准备更多能力',
          icon: Icons.chat_bubble_outline_rounded,
        ),
        if (c.pending != null || c.uploadRecoveryStatus != null) ...[
          const SizedBox(height: 16),
          _pendingOperation(),
        ],
      ],
    );
  }

  Widget _metric(String value, String label, Color color) => Column(
    children: [
      Text(
        value,
        style: TextStyle(
          fontSize: 28,
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
      const SizedBox(height: 3),
      Text(
        label,
        style: const TextStyle(fontSize: 11, color: Color(0xFFB8CFD0)),
      ),
    ],
  );

  Widget _shortcut(
    String title,
    String subtitle,
    IconData icon,
    VoidCallback onTap, {
    bool orange = false,
  }) => Material(
    color: orange ? paleOrange : paleTeal,
    borderRadius: BorderRadius.circular(19),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.all(17),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: orange ? warmOrange : teal, size: 26),
            const SizedBox(height: 15),
            Text(
              title,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: orange ? warmOrange : teal,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              subtitle,
              style: const TextStyle(
                fontSize: 11,
                color: mutedInk,
                height: 1.5,
              ),
            ),
          ],
        ),
      ),
    ),
  );

  Widget _tasks() {
    final filtered = c.tasks
        .where(
          (task) => switch (_filter) {
            '待处理' => [
              'unread',
              'awaiting_confirmation',
              'awaiting_submission',
            ].contains(task.status),
            '已提交' => task.state['submission_status'] == 'submitted',
            '待补正' => task.status == 'needs_revision',
            '已完成' => ['approved', 'completed'].contains(task.status),
            _ => true,
          },
        )
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '把每件事，\n安放在进度里。',
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 12),
        Text(
          '当前账号已加载 ${c.tasks.length} 项 · 显示 ${filtered.length} 项',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 18),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          children: ['全部', '待处理', '已提交', '待补正', '已完成']
              .map(
                (filter) => ChoiceChip(
                  label: Text(filter),
                  selected: _filter == filter,
                  onSelected: (_) => setState(() => _filter = filter),
                  selectedColor: paleTeal,
                  showCheckmark: false,
                  side: BorderSide(color: _filter == filter ? teal : line),
                  labelStyle: TextStyle(
                    color: _filter == filter ? teal : mutedInk,
                    fontSize: 13,
                  ),
                ),
              )
              .toList(),
        ),
        const SizedBox(height: 20),
        if (filtered.isEmpty)
          const EmptyState(title: '这个分类里暂时没有事项', message: '可以切换分类，或下拉刷新最新记录。')
        else
          ...filtered.map(
            (task) => TaskTile(
              task: task,
              enabled: !c.busy,
              onTap: () => c.openTask(task.id),
            ),
          ),
        const SizedBox(height: 8),
        const Text(
          '筛选仅作用于已加载任务；已提交与审核通过分别记录。',
          style: TextStyle(fontSize: 12, color: mutedInk),
        ),
      ],
    );
  }

  Widget _discovery() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('发现校园里的\n更多可能。', style: Theme.of(context).textTheme.headlineMedium),
      const SizedBox(height: 14),
      const Text(
        '活动、校园服务与个人成果，会在真实能力接入后逐项开放。',
        style: TextStyle(color: mutedInk, height: 1.7),
      ),
      const SizedBox(height: 28),
      const EmptyState(
        title: '这里正在准备中',
        message: '当前没有已接通的发现服务。\n暂不提供活动报名、场地预约或文件生成入口。',
        icon: Icons.explore_outlined,
      ),
      const SizedBox(height: 20),
      const InfoBox('你仍然可以在“待办”完成现有任务，在“我的”查看演示身份与接口接入状态。'),
    ],
  );

  Widget _pendingOperation() => Column(
    children: [
      if (c.pending != null) PendingOperationPanel(controller: c),
      if (c.uploadRecoveryStatus != null) ...[
        if (c.pending != null) const SizedBox(height: 12),
        UploadRecoveryPanel(controller: c),
      ],
    ],
  );

  Widget _profile() {
    final identity = c.identity ?? {};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 57,
                    height: 57,
                    decoration: BoxDecoration(
                      color: paleTeal,
                      borderRadius: BorderRadius.circular(19),
                    ),
                    child: const Icon(
                      Icons.person_outline_rounded,
                      color: teal,
                      size: 32,
                    ),
                  ),
                  const SizedBox(width: 15),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          identity['display_name']?.toString() ?? '演示学生',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 5),
                        Text(
                          '独立演示账号 ${c.account?.toUpperCase() ?? ''}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const Divider(),
              DetailLine(
                '身份编号',
                identity['user_id']?.toString() ?? '待读取',
                selectable: true,
              ),
              DetailLine(
                '关联班级',
                identity['active_class_id']?.toString() ?? '尚未关联',
              ),
              DetailLine('服务状态', c.connected ? '本机演示服务已连接' : '尚未连接'),
            ],
          ),
        ),
        if (c.pending != null || c.uploadRecoveryStatus != null) ...[
          const SizedBox(height: 18),
          _pendingOperation(),
        ],
        const SectionHeading('账号与记录', subtitle: '同名不合并，退出清理当前账号页面'),
        OutlinedButton.icon(
          onPressed: c.busy ? null : () => showMessageCenter(context, c),
          icon: const Icon(Icons.notifications_none_rounded),
          label: const Text('查看站内消息'),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: c.busy ? null : () => showRunBrowser(context, c),
          icon: const Icon(Icons.account_tree_outlined),
          label: const Text('查看我的执行记录'),
        ),
        const SizedBox(height: 12),
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '提交记录可从对应任务进入查看。已提交、待审核和审核通过是不同状态。',
                style: TextStyle(fontSize: 13, height: 1.7, color: mutedInk),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  OutlinedButton.icon(
                    onPressed: c.busy
                        ? null
                        : () => _switchAccount(c.account == 'a' ? 'b' : 'a'),
                    icon: const Icon(Icons.switch_account_outlined, size: 18),
                    label: Text('切换到账号 ${c.account == 'a' ? 'B' : 'A'}'),
                  ),
                  TextButton.icon(
                    onPressed: c.busy ? null : () => _switchAccount(null),
                    icon: const Icon(Icons.logout_rounded, size: 18),
                    label: const Text('退出演示账号'),
                  ),
                ],
              ),
            ],
          ),
        ),
        ConfirmedProfilePanel(controller: c),
        const SectionHeading('接口接入状态'),
        Panel(
          child: Column(
            children: [
              _featureRow(
                Icons.assignment_outlined,
                '任务、草稿与提交',
                '连接本机虚拟数据',
                true,
              ),
              const Divider(),
              _featureRow(
                Icons.chat_bubble_outline_rounded,
                '自然语言主对话',
                '接口已定义，客户端与服务尚待接入',
                false,
              ),
              const Divider(),
              _featureRow(
                Icons.notifications_none_rounded,
                '站内消息',
                '本机虚拟消息可读；真实推送未接入',
                true,
              ),
              const Divider(),
              _featureRow(
                Icons.badge_outlined,
                '本人档案读取',
                '演示可读，当前无已确认事实；审核意见未接入',
                true,
              ),
            ],
          ),
        ),
        const SectionHeading('演示故障实验台', subtitle: '仅用于验证虚拟任务的异常与恢复'),
        ScenarioPanel(controller: c),
        const SizedBox(height: 22),
        const Text(
          '知行 · 校园助理  v0.1.0\n契约 0.2.0 · 当前为演示骨架，未完成真实 P0 验收',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 11, height: 1.7, color: mutedInk),
        ),
      ],
    );
  }

  Widget _featureRow(
    IconData icon,
    String title,
    String subtitle,
    bool ready,
  ) => Row(
    children: [
      Icon(icon, size: 22, color: ready ? teal : mutedInk),
      const SizedBox(width: 12),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 3),
            Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      const SizedBox(width: 8),
      SmallBadge(
        ready ? '演示' : '待接入',
        color: ready ? teal : mutedInk,
        background: ready ? paleTeal : const Color(0xFFF1F3F0),
      ),
    ],
  );
}
