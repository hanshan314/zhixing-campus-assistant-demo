import 'package:flutter/material.dart';
import '../controllers/app_controller.dart';
import '../domain/models.dart';
import 'components.dart';
import 'pending_operation_panel.dart';
import 'style.dart';

const runStatusLabels = {
  'queued': '已受理，正在排队',
  'running': '正在执行',
  'waiting_input': '等待补充信息',
  'cancelling': '取消处理中',
  'succeeded': '本次执行完成',
  'failed': '本次执行失败',
  'cancelled': '已取消',
};

Future<void> showRunBrowser(
  BuildContext context,
  AppController controller, {
  String? runId,
}) async {
  if (controller.busy || controller.identity == null) return;
  final epoch = controller.sessionEpoch;
  final userId = controller.identity?['user_id'];
  controller.closeRun();
  try {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: paper,
      builder: (_) => GuardedConfirmation(
        controller: controller,
        isCurrent: () =>
            controller.sessionEpoch == epoch &&
            controller.identity != null &&
            controller.identity?['user_id'] == userId,
        expiredBuilder: (_) => const SafeArea(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: ExpiredConfirmation(inDialog: false),
          ),
        ),
        builder: (_) =>
            _RunBrowser(controller: controller, initialRunId: runId),
      ),
    );
  } finally {
    controller.closeRun();
  }
}

class _RunBrowser extends StatefulWidget {
  const _RunBrowser({required this.controller, this.initialRunId});
  final AppController controller;
  final String? initialRunId;
  @override
  State<_RunBrowser> createState() => _RunBrowserState();
}

class _RunBrowserState extends State<_RunBrowser> {
  AppController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      if (widget.initialRunId != null) {
        await c.openRun(widget.initialRunId!);
      } else {
        await c.loadRuns();
      }
    });
  }

  Future<void> _list() async {
    c.closeRun();
    if (!c.busy) await c.loadRuns();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) => FractionallySizedBox(
      heightFactor: .92,
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 8),
              child: Row(
                children: [
                  if (c.selectedRun != null)
                    IconButton(
                      onPressed: c.busy ? null : _list,
                      tooltip: '返回执行列表',
                      icon: const Icon(Icons.arrow_back_rounded),
                    ),
                  Expanded(
                    child: Text(
                      c.selectedRun == null ? '我的执行记录' : '执行详情',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    tooltip: '关闭执行记录',
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            if (c.busy) const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: RefreshIndicator(
                onRefresh: c.busy
                    ? () async {}
                    : c.selectedRun == null
                    ? c.loadRuns
                    : () => c.openRun(c.selectedRun!['run_id'] as String),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
                  physics: const AlwaysScrollableScrollPhysics(),
                  keyboardDismissBehavior:
                      ScrollViewKeyboardDismissBehavior.onDrag,
                  children: [
                    if (c.error != null) ...[
                      InfoBox(c.error!, title: '暂时无法完成这一步', warning: true),
                      const SizedBox(height: 12),
                    ],
                    if (c.notice != null) ...[
                      InfoBox(c.notice!),
                      const SizedBox(height: 12),
                    ],
                    if (c.pending != null) ...[
                      PendingOperationPanel(controller: c),
                      const SizedBox(height: 12),
                    ],
                    if (c.selectedRun == null)
                      ..._listContent()
                    else
                      _detail(c.selectedRun!),
                    const SizedBox(height: 16),
                    const Text(
                      '关闭此页不会取消后台执行。执行完成与正式提交、审核通过分别记录。',
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.6,
                        color: mutedInk,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );

  List<Widget> _listContent() {
    if (c.error != null && c.runs.isEmpty && !c.busy) {
      return [
        OutlinedButton(
          onPressed: c.loadRuns,
          child: const Text('重新读取执行列表'),
        ),
      ];
    }
    return [
    Text(
      '本人已加载 ${c.runs.length} 条执行记录',
      style: const TextStyle(fontSize: 13, color: mutedInk),
    ),
    const SizedBox(height: 12),
    if (c.runs.isEmpty && !c.busy)
      EmptyState(
        title: '当前没有已加载的执行记录',
        message: '可以刷新重新读取本人记录。',
        action: OutlinedButton(
          onPressed: c.loadRuns,
          child: const Text('刷新执行列表'),
        ),
      ),
    ...c.runs.map(
      (run) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SmallBadge(runStatusLabels[run['status']] ?? '状态待核对'),
              const SizedBox(height: 10),
              DetailLine(
                '执行编号',
                run['run_id']?.toString() ?? '暂无',
                selectable: true,
              ),
              DetailLine('发起时间', chinaTime(run['created_at'])),
              DetailLine(
                '执行类型',
                run['action'] == 'check_materials'
                    ? '材料检查'
                    : run['action']?.toString() ?? '待核对',
              ),
              OutlinedButton(
                onPressed: c.busy
                    ? null
                    : () => c.openRun(run['run_id'] as String),
                child: const Text('查看执行详情'),
              ),
            ],
          ),
        ),
      ),
    ),
    ];
  }

  Widget _detail(Json run) {
    final error = jsonMap(run['error']);
    final result = jsonMap(run['result_ref']);
    final retryable =
        run['status'] == 'cancelled' ||
        (run['status'] == 'failed' && error['retryable'] == true);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SmallBadge(runStatusLabels[run['status']] ?? '状态待核对'),
              const SizedBox(height: 12),
              DetailLine(
                '执行编号',
                run['run_id']?.toString() ?? '暂无',
                selectable: true,
              ),
              DetailLine('记录版本', 'v${run['resource_version']}'),
              DetailLine('更新时间', chinaTime(run['updated_at'])),
              if (run['retry_of'] != null)
                DetailLine(
                  '关联原执行',
                  run['retry_of'].toString(),
                  selectable: true,
                ),
              if (run['poll_after_seconds'] != null)
                DetailLine('状态刷新', '按服务端提示，每 ${run['poll_after_seconds']} 秒查询'),
            ],
          ),
        ),
        const SectionHeading('执行步骤'),
        ...jsonList(run['steps']).map(
          (step) => Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: InfoBox(
              '${step['name'] ?? '执行步骤'} · ${runStatusLabels[step['status']] ?? step['status'] ?? '待核对'}',
              warning: step['status'] == 'failed',
            ),
          ),
        ),
        if (error.isNotEmpty) ...[
          InfoBox(
            error['message']?.toString() ?? '执行失败，原文件和草稿仍保留。',
            title: '执行未完成',
            warning: true,
          ),
          const SizedBox(height: 12),
        ],
        if (result.isNotEmpty)
          Panel(
            child: Column(
              children: [
                DetailLine('结果类型', result['kind']?.toString() ?? '待核对'),
                DetailLine(
                  '结果编号',
                  result['id']?.toString() ?? '待核对',
                  selectable: true,
                ),
                const Text('材料检查结果可在对应任务中查看；文件成果仅在已开放能力中提供。'),
              ],
            ),
          ),
        if (run['status'] == 'waiting_input') ...[
          const SizedBox(height: 12),
          const InfoBox('请补充服务端列出的信息。原文件与草稿仍保留，补充受理不等于正式提交。'),
          _RunInputs(
            key: ValueKey(
              '${c.sessionEpoch}:${run['run_id']}:${run['resource_version']}',
            ),
            controller: c,
            run: run,
          ),
        ],
        const SizedBox(height: 14),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton(
              onPressed: c.busy
                  ? null
                  : () => c.openRun(run['run_id'] as String),
              child: const Text('刷新执行状态'),
            ),
            if (retryable)
              OutlinedButton(
                onPressed: c.busy || c.pending != null ? null : c.retryRun,
                child: const Text('创建关联重试执行'),
              ),
            if (run['cancellable'] == true)
              OutlinedButton(
                onPressed: c.busy || c.pending != null ? null : c.cancelRun,
                child: const Text('请求取消执行'),
              ),
          ],
        ),
      ],
    );
  }
}

class _RunInputs extends StatefulWidget {
  const _RunInputs({super.key, required this.controller, required this.run});
  final AppController controller;
  final Json run;
  @override
  State<_RunInputs> createState() => _RunInputsState();
}

class _RunInputsState extends State<_RunInputs> {
  final _values = <String, String>{};
  late final int _epoch = widget.controller.sessionEpoch;
  Future<void> _send() async {
    final c = widget.controller;
    if (c.busy ||
        c.pending != null ||
        c.sessionEpoch != _epoch ||
        c.selectedRun?['run_id'] != widget.run['run_id'] ||
        c.selectedRun?['resource_version'] != widget.run['resource_version'] ||
        c.selectedRun?['status'] != 'waiting_input') {
      return;
    }
    await c.supplyRunInputs([
      for (final field in jsonList(widget.run['input_fields']))
        if ((_values[field['name']] ?? '').trim().isNotEmpty ||
            field['required'] == true)
          {
            'name': field['name'] as String,
            'value': _values[field['name']] ?? '',
          },
    ]);
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final field in jsonList(widget.run['input_fields']))
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: field['type'] == 'choice'
                  ? DropdownButtonFormField<String>(
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText:
                            field['label']?.toString() ??
                            field['name'].toString(),
                      ),
                      items: [
                        for (final choice in field['choices'] as List? ?? [])
                          DropdownMenuItem(
                            value: choice.toString(),
                            child: Text(choice.toString()),
                          ),
                      ],
                      onChanged: widget.controller.busy
                          ? null
                          : (value) =>
                                _values[field['name'] as String] = value ?? '',
                    )
                  : TextField(
                      enabled:
                          !widget.controller.busy &&
                          widget.controller.pending == null,
                      minLines: 1,
                      maxLines: 4,
                      decoration: InputDecoration(
                        labelText:
                            field['label']?.toString() ??
                            field['name'].toString(),
                        helperText: field['type'] == 'file_id'
                            ? '填写本人已保存的文件编号，不会重新上传。'
                            : null,
                      ),
                      onChanged: (value) =>
                          _values[field['name'] as String] = value,
                    ),
            ),
          FilledButton(
            onPressed:
                widget.controller.busy || widget.controller.pending != null
                ? null
                : _send,
            child: const Text('提交补充信息'),
          ),
        ],
      ),
    ),
  );
}
