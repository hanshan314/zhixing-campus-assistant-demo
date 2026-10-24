import 'package:flutter/material.dart';
import '../controllers/app_controller.dart';
import '../domain/models.dart';
import 'components.dart';
import 'pending_operation_panel.dart';
import 'style.dart';

Future<void> showMessageCenter(BuildContext context, AppController controller) async {
  if (controller.busy || controller.identity == null) return;
  final epoch = controller.sessionEpoch;
  final userId = controller.identity?['user_id'];
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: paper,
    builder: (_) => GuardedConfirmation(
      controller: controller,
      isCurrent: () => controller.sessionEpoch == epoch &&
          controller.identity != null && controller.identity?['user_id'] == userId,
      expiredBuilder: (_) => const ExpiredConfirmation(inDialog: false),
      builder: (_) => _MessageCenter(controller: controller),
    ),
  );
}

class _MessageCenter extends StatefulWidget {
  const _MessageCenter({required this.controller});
  final AppController controller;
  @override
  State<_MessageCenter> createState() => _MessageCenterState();
}

class _MessageCenterState extends State<_MessageCenter> {
  AppController get c => widget.controller;
  late final int _epoch = c.sessionEpoch;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (mounted && c.sessionEpoch == _epoch && c.identity != null) {
        await c.loadNotifications();
      }
    });
  }

  Future<void> _open(Json message) async {
    if (c.busy || c.pending != null) return;
    final epoch = c.sessionEpoch;
    await c.openNotification(message['notification_id'] as String);
    if (!mounted || c.sessionEpoch != epoch || c.identity == null) return;
    if (c.error == null && c.task != null &&
        ModalRoute.of(context)?.isCurrent == true) {
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) => FractionallySizedBox(
      heightFactor: .92,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 8, 8),
          child: Row(children: [
            Expanded(child: Text('消息中心', style: Theme.of(context).textTheme.titleLarge)),
            IconButton(onPressed: () => Navigator.pop(context),
              tooltip: '关闭消息中心', icon: const Icon(Icons.close_rounded)),
          ]),
        ),
        if (c.busy) const LinearProgressIndicator(minHeight: 2),
        Expanded(child: RefreshIndicator(
          onRefresh: c.busy ? () async {} : c.loadNotifications,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              const InfoBox('当前是本机虚拟站内消息。渠道已保存、消息已读和任务主动确认分别记录；真实推送尚未接入。'),
              const SizedBox(height: 12),
              if (c.error != null) ...[
                InfoBox(c.error!, title: '消息暂时无法读取或操作', warning: true),
                const SizedBox(height: 12),
              ],
              if (c.notice != null) ...[
                InfoBox(c.notice!), const SizedBox(height: 12),
              ],
              if (c.pending != null) ...[
                PendingOperationPanel(controller: c), const SizedBox(height: 12),
              ],
              if (c.error != null && !c.busy)
                OutlinedButton(onPressed: c.loadNotifications,
                  child: const Text('重新读取消息'))
              else if (!c.notificationsLoaded && !c.busy)
                EmptyState(title: '消息尚未加载', message: '请重试读取本人可见的站内消息。',
                  action: OutlinedButton(onPressed: c.loadNotifications, child: const Text('加载站内消息')))
              else if (c.notificationsLoaded && c.notifications.isEmpty && !c.busy)
                const EmptyState(title: '当前没有已加载的消息', message: '下拉刷新可重新读取本人记录。')
              else if (c.notificationsLoaded && c.error == null) ...[
                Text('本人已加载 ${c.notifications.length} 条消息',
                  style: const TextStyle(fontSize: 13, color: mutedInk)),
                const SizedBox(height: 12),
                ...c.notifications.map(_message),
              ],
            ],
          ),
        )),
      ]),
    ),
  );

  Widget _message(Json message) {
    final target = jsonMap(message['target']);
    final type = switch (message['kind']) {
      'task_published' => '任务通知',
      'requirements_changed' => '要求更新',
      'review_feedback' => '审核反馈',
      'reminder' => '事务提醒',
      _ => '站内消息',
    };
    final read = message['read_status'] == 'read';
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Panel(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(spacing: 8, runSpacing: 6, children: [
          SmallBadge(type),
          SmallBadge(read ? '已读' : '未读', color: read ? mutedInk : teal),
          SmallBadge(message['delivery_status'] == 'stored' ? '站内已保存' : '渠道状态待核对',
            color: mutedInk),
        ]),
        const SizedBox(height: 12),
        Text(message['title']?.toString() ?? '消息标题待核对',
          style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 10),
        DetailLine('消息时间', chinaTime(message['created_at'])),
        if (read) DetailLine('阅读时间', chinaTime(message['read_at'])),
        DetailLine('关联编号', target['id']?.toString() ?? '暂无', selectable: true),
        if (target['kind'] != 'task')
          const Text('此类消息目标尚未开放，暂时不能跳转。', style: TextStyle(color: mutedInk)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (!read) OutlinedButton(
            onPressed: c.busy || c.pending != null ? null
                : () => c.readNotification(message['notification_id'] as String),
            child: const Text('标记消息已读')),
          OutlinedButton(
            onPressed: c.busy || c.pending != null || target['kind'] != 'task'
                ? null : () => _open(message),
            child: const Text('查看关联任务')),
        ]),
      ])),
    );
  }
}

class ConfirmedProfilePanel extends StatelessWidget {
  const ConfirmedProfilePanel({super.key, required this.controller});
  final AppController controller;
  @override
  Widget build(BuildContext context) {
    final profile = controller.profile;
    final visible = profile?['visible_fields'] as List? ?? [];
    final facts = jsonList(profile?['facts']).where((fact) =>
      fact['user_id'] == controller.identity?['user_id'] && visible.contains(fact['field'])).toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SectionHeading('本人已确认资料', subtitle: '仅展示服务端确认且允许本人查看的字段'),
      OutlinedButton.icon(onPressed: controller.busy ? null : controller.loadProfile,
        icon: const Icon(Icons.refresh_rounded, size: 18),
        label: Text(controller.profileLoaded ? '刷新本人已确认资料' : '读取本人已确认资料')),
      const SizedBox(height: 12),
      if (controller.error != null)
        InfoBox(controller.error!, title: '已确认资料暂时无法核对，请重新读取', warning: true)
      else if (!controller.profileLoaded)
        const InfoBox('尚未读取已确认资料。登录姓名不自动作为已确认档案。')
      else if (facts.isEmpty)
        const EmptyState(title: '暂无可见的已确认资料',
          message: '当前服务返回的本人可见档案为空，不会用姓名或 AI 推测补全。', icon: Icons.badge_outlined)
      else ...facts.map((fact) {
        final provenance = jsonMap(fact['provenance']);
        return Padding(padding: const EdgeInsets.only(bottom: 12), child: Panel(
          child: Column(children: [
            DetailLine('资料字段', fact['field'].toString()),
            DetailLine('确认内容', fact['value'].toString()),
            DetailLine('事实版本', 'v${fact['fact_version']}'),
            DetailLine('确认时间', chinaTime(fact['confirmed_at'])),
            DetailLine('确认记录人', fact['confirmed_by']?.toString() ?? '待核对', selectable: true),
            DetailLine('来源任务', provenance['task_id']?.toString() ?? '待核对', selectable: true),
            DetailLine('来源提交', provenance['submission_id']?.toString() ?? '待核对', selectable: true),
            DetailLine('提交版本', 'v${provenance['submission_version']}'),
            DetailLine('来源审核', provenance['review_id']?.toString() ?? '待核对', selectable: true),
            for (final evidence in jsonList(provenance['evidence']))
              Text('${evidence['location'] ?? ''} ${evidence['quote'] ?? ''}'.trim()),
          ]),
        ));
      }),
      const SizedBox(height: 12),
      const InfoBox('当前仅接入演示档案读取。完整审核意见与历史要求尚待接口补齐，真实学校资料服务未接入。'),
    ]);
  }
}
