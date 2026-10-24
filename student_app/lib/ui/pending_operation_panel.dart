import 'dart:convert';
import 'package:flutter/material.dart';
import '../controllers/app_controller.dart';
import 'components.dart';
import 'style.dart';

class PendingOperationPanel extends StatelessWidget {
  const PendingOperationPanel({super.key, required this.controller});
  final AppController controller;

  Future<void> _retry(BuildContext context) async {
    final operation = controller.pending;
    if (operation == null || !controller.canRetryOriginal || controller.busy) {
      return;
    }
    final currentController = controller;
    final account = currentController.account;
    final userId = currentController.identity?['user_id'];
    final epoch = currentController.sessionEpoch;
    final bodyJson = jsonEncode(operation.body);
    final body = Map<String, dynamic>.unmodifiable(
      jsonDecode(bodyJson) as Map<String, dynamic>,
    );
    bool isCurrent() =>
        currentController.account == account &&
        currentController.identity != null &&
        currentController.identity?['user_id'] == userId &&
        currentController.sessionEpoch == epoch &&
        identical(currentController.pending, operation) &&
        jsonEncode(currentController.pending?.body) == bodyJson &&
        currentController.canRetryOriginal &&
        !currentController.busy;
    final action = switch (operation.action) {
      'submit_materials' => '正式提交材料',
      'confirm_notice' => '确认任务要求',
      'start_check' => '启动草稿检查',
      'upload_file' => '保存原文件',
      'retry_run' => '创建关联重试执行',
      'cancel_run' => '请求取消执行',
      'supply_run_input' => '补充执行信息',
      'read_notification' => '记录消息已读',
      _ => operation.action,
    };
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => GuardedConfirmation(
        controller: currentController,
        isCurrent: isCurrent,
        expiredBuilder: (_) => const ExpiredConfirmation(inDialog: true),
        builder: (dialogContext) => AlertDialog(
          title: const Text('按原操作重试'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '刚才的查询仍未确定结果。请核对原操作，本次将使用已保存的同一个操作键和同一份参数。',
                  style: TextStyle(fontSize: 13, height: 1.7, color: mutedInk),
                ),
                const SizedBox(height: 16),
                DetailLine('账号', '演示账号 ${account?.toUpperCase() ?? ''}'),
                DetailLine('原操作', action),
                DetailLine('目标编号', operation.targetId, selectable: true),
                if (operation.action == 'upload_file') ...[
                  DetailLine('文件', operation.multipart?['filename']?.toString() ?? '旧上传记录'),
                  DetailLine('大小', fileSize(operation.multipart?['size'])),
                  DetailLine('说明', '仅按原文件与原键保存，不会正式提交。'),
                ],
                if (body['draft_id'] != null)
                  DetailLine(
                    '草稿编号',
                    body['draft_id'].toString(),
                    selectable: true,
                  ),
                if (body['draft_version'] != null)
                  DetailLine('草稿版本', 'v${body['draft_version']}'),
                if (body['requirement_version'] != null)
                  DetailLine('要求版本', 'v${body['requirement_version']}'),
                if (body['resource_version'] != null)
                  DetailLine(operation.action == 'read_notification' ? '消息版本' : '执行版本',
                    'v${body['resource_version']}'),
                if (body.containsKey('expected_effective_submission_id'))
                  DetailLine(
                    '预期原提交',
                    body['expected_effective_submission_id']?.toString() ??
                        '无，首次提交',
                    selectable: true,
                  ),
                const SizedBox(height: 12),
                const Text(
                  '页面上后来修改的材料不会替换这份原参数。重试仍可能需要继续查询，只有取得真实回执后才显示成功。',
                  style: TextStyle(fontSize: 12, height: 1.6, color: mutedInk),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('暂不重试'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('使用原参数重试'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true || !context.mounted) return;
    if (!isCurrent()) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('原操作状态已经变化，请重新查询核对。')));
      return;
    }
    await controller.retryPending();
  }

  @override
  Widget build(BuildContext context) => InfoBox(
    '网络结果尚未确定，原操作信息已保留。先查询原结果；只有服务允许时，才能按已保存的原参数重试。',
    title: '正在确认操作结果',
    warning: true,
    action: Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        OutlinedButton.icon(
          onPressed: controller.busy ? null : controller.reconcile,
          icon: const Icon(Icons.sync_rounded, size: 18),
          label: const Text('查询原操作结果'),
        ),
        OutlinedButton.icon(
          onPressed: controller.canRetryOriginal && !controller.busy
              ? () => _retry(context)
              : null,
          icon: const Icon(Icons.replay_rounded, size: 18),
          label: const Text('按原操作重试'),
        ),
      ],
    ),
  );
}

class UploadRecoveryPanel extends StatelessWidget {
  const UploadRecoveryPanel({super.key, required this.controller, this.onDownload,
    this.onOpenOriginal});
  final AppController controller;
  final VoidCallback? onDownload;
  final Future<void> Function()? onOpenOriginal;

  @override
  Widget build(BuildContext context) {
    final status = controller.uploadRecoveryStatus;
    if (status == null) return const SizedBox.shrink();
    final file = controller.savedUpload;
    final originalTask = controller.savedUploadTaskId;
    final onOriginalTask = originalTask != null && controller.task?.id == originalTask;
    final draftMatches = controller.draft == null ||
        controller.draft?['draft_id'] == controller.savedUploadDraftId;
    final shownInDraft = status == 'bound' && onOriginalTask &&
        controller.draft?['draft_id'] == controller.savedUploadDraftId &&
        (controller.draft?['file_ids'] as List? ?? []).contains(file?['file_id']);
    final canBind = status == 'saved_unbound' && onOriginalTask &&
        draftMatches && !controller.busy && controller.pending == null;
    final title = switch (status) {
      'unknown' => '文件保存结果待确认',
      'saved_unbound' => '文件已保存，尚未加入草稿',
      'bound' => '文件已保存并加入原草稿',
      'failed' => '本次文件保存未完成',
      _ => '文件恢复状态待核对',
    };
    final message = switch (status) {
      'unknown' => '原操作已保留。请查询原操作结果，避免再次上传同一份文件。文件保存不等于正式提交。',
      'saved_unbound' => '原文件仍在服务端。核对原任务与草稿后，将这份文件加入原草稿即可，不需要重新上传。',
      'bound' => '加入草稿不等于正式提交。是否已有正式提交，请以任务状态与提交回执为准。',
      'failed' => controller.error ?? '本次上传未取得保存结果。请核对错误和服务限制后再选择文件。',
      _ => '请刷新记录后继续核对。',
    };
    return InfoBox(
      message,
      title: title,
      warning: status != 'bound',
      action: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (file != null && !shownInDraft) ...[
            DetailLine('文件', file['filename']?.toString() ?? '已保存原文件'),
            DetailLine('大小', fileSize(file['size'])),
            if (controller.savedUploadDraftId != null)
              DetailLine('原草稿', controller.savedUploadDraftId!, selectable: true),
          ],
          if (status == 'saved_unbound') ...[
            if (!onOriginalTask)
              const Text('请先打开原任务，再核对文件绑定；不会加入当前任务的草稿。'),
            if (onOriginalTask && !draftMatches)
              const Text('当前选择的草稿与原文件目标不同。请核对原草稿，不会覆盖当前草稿。'),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (!onOriginalTask && originalTask != null)
                OutlinedButton(
                  onPressed: controller.busy ? null :
                      onOpenOriginal ?? () => controller.openTask(originalTask),
                  child: const Text('打开原任务'),
                ),
              OutlinedButton(
                onPressed: canBind ? controller.bindSavedUpload : null,
                child: const Text('将已保存文件加入原草稿'),
              ),
            ]),
          ],
          if (onDownload != null && file != null && !shownInDraft)
            TextButton.icon(
              onPressed: controller.busy ? null : onDownload,
              icon: const Icon(Icons.download_outlined, size: 18),
              label: const Text('保存原文件到设备'),
            ),
          if (file != null && !shownInDraft)
            const Text('当前内容预览与解析未开放，可通过受控入口保存原文件。',
              style: TextStyle(fontSize: 11, color: mutedInk)),
        ],
      ),
    );
  }
}

/// A modal route outlives its launching page. It owns this subscription and
/// irreversibly removes private content when the original confirmation expires.
class GuardedConfirmation extends StatefulWidget {
  const GuardedConfirmation({
    super.key,
    required this.controller,
    required this.isCurrent,
    required this.builder,
    required this.expiredBuilder,
  });

  final AppController controller;
  final bool Function() isCurrent;
  final WidgetBuilder builder;
  final WidgetBuilder expiredBuilder;

  @override
  State<GuardedConfirmation> createState() => _GuardedConfirmationState();
}

class _GuardedConfirmationState extends State<GuardedConfirmation> {
  bool _expired = false;

  @override
  void initState() {
    super.initState();
    _expired = !widget.isCurrent();
    widget.controller.addListener(_checkCurrent);
  }

  @override
  void didUpdateWidget(covariant GuardedConfirmation oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_checkCurrent);
      widget.controller.addListener(_checkCurrent);
    }
    _expired = _expired || !widget.isCurrent();
  }

  void _checkCurrent() {
    if (!_expired && mounted && !widget.isCurrent()) {
      setState(() => _expired = true);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_checkCurrent);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _expired = _expired || !widget.isCurrent();
    return _expired ? widget.expiredBuilder(context) : widget.builder(context);
  }
}

class ExpiredConfirmation extends StatelessWidget {
  const ExpiredConfirmation({super.key, required this.inDialog});
  final bool inDialog;

  @override
  Widget build(BuildContext context) {
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.lock_outline_rounded, color: mutedInk),
        const SizedBox(height: 16),
        Text('预览已失效', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        const Text('账号、权限或操作内容已经变化。请关闭后重新核对。'),
        const SizedBox(height: 20),
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('关闭预览'),
        ),
      ],
    );
    return inDialog
        ? AlertDialog(content: content)
        : SafeArea(
            child: Padding(padding: const EdgeInsets.all(24), child: content),
          );
  }
}
