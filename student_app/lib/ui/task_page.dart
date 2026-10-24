import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb, listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../controllers/app_controller.dart';
import '../domain/models.dart';
import 'components.dart';
import 'pending_operation_panel.dart';
import 'scenario_panel.dart';
import 'run_browser.dart';
import 'style.dart';

class TaskPage extends StatefulWidget {
  const TaskPage({super.key, required this.controller});
  final AppController controller;
  @override
  State<TaskPage> createState() => TaskPageState();
}

class TaskPageState extends State<TaskPage> {
  final _text = TextEditingController();
  String? _draftId;
  int? _textSessionEpoch;
  String? _textUserId;
  String? _textTaskId;
  bool _dirty = false;
  bool _askingToLeave = false;
  bool _picking = false;
  bool _savingFile = false;
  String? _localError;
  String? _fileNotice;
  AppController get c => widget.controller;
  bool get busy => c.busy || _picking || _savingFile;
  bool get _uploadUnresolved =>
      c.pending != null ||
      c.uploadRecoveryStatus == 'unknown' ||
      c.uploadRecoveryStatus == 'saved_unbound';
  CampusTask get task => c.task!;

  @override
  void initState() {
    super.initState();
    _syncText();
  }

  @override
  void didUpdateWidget(covariant TaskPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncText();
  }

  void _syncText() {
    final id = c.draft?['draft_id']?.toString();
    final epoch = c.sessionEpoch;
    final userId = c.identity?['user_id']?.toString();
    final taskId = c.task?.id;
    if (_textSessionEpoch != epoch || _textUserId != userId || _textTaskId != taskId) {
      _localError = null;
      _fileNotice = null;
    }
    if (_draftId != id ||
        _textSessionEpoch != epoch ||
        _textUserId != userId ||
        _textTaskId != taskId ||
        !_dirty) {
      _draftId = id;
      _textSessionEpoch = epoch;
      _textUserId = userId;
      _textTaskId = taskId;
      _text.text = c.draft?['text']?.toString() ?? '';
      _dirty = false;
    }
  }

  /// Both the app bar and the platform back action use this draft-only guard.
  Future<bool> requestLeave() async {
    if (_askingToLeave || busy) return false;
    if (!_dirty) return true;
    final controller = c;
    final account = controller.account;
    final userId = controller.identity?['user_id'];
    final epoch = controller.sessionEpoch;
    final taskId = controller.task?.id;
    final draftId = controller.draft?['draft_id'];
    final draftVersion = controller.draft?['draft_version'];
    final requirementVersion = controller.task?.requirementVersion;
    final effectiveSubmission = controller.task?.effectiveSubmission;
    final value = _text.text;
    bool sameContext() =>
        controller.account == account &&
        controller.identity != null &&
        controller.identity?['user_id'] == userId &&
        controller.sessionEpoch == epoch &&
        controller.task?.id == taskId &&
        controller.task?.requirementVersion == requirementVersion &&
        controller.task?.effectiveSubmission == effectiveSubmission &&
        controller.draft?['draft_id'] == draftId;
    bool previewCurrent() =>
        sameContext() &&
        draftId != null &&
        controller.draft?['draft_version'] == draftVersion &&
        !controller.busy;
    _askingToLeave = true;
    try {
      final choice = await _chooseDirtyDraftAction(
        controller: controller,
        isCurrent: previewCurrent,
      );
      if (!mounted || !previewCurrent()) return false;
      if (choice == 'discard') return true;
      if (choice != 'save') return false;
      await controller.saveText(value);
      if (!mounted || !sameContext()) return false;
      if (controller.error != null ||
          controller.busy ||
          controller.draft?['text'] != value ||
          _text.text != value) {
        setState(() => _localError = '说明尚未确认保存，请保留当前输入并核对后重试。');
        return false;
      }
      setState(() => _dirty = false);
      return true;
    } finally {
      _askingToLeave = false;
    }
  }

  Future<String?> _chooseDirtyDraftAction({
    required AppController controller,
    required bool Function() isCurrent,
    bool replacingDraft = false,
  }) => showDialog<String>(
    context: context,
    builder: (dialogContext) => GuardedConfirmation(
      controller: controller,
      isCurrent: isCurrent,
      expiredBuilder: (_) => AlertDialog(
        title: const Text('草稿状态已经变化'),
        content: const Text('账号、任务或草稿已更新。请返回核对，尚未保存的说明不会发送到新的账号或草稿。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('返回核对'),
          ),
        ],
      ),
      builder: (dialogContext) => AlertDialog(
        title: const Text('说明文字尚未保存'),
        content: SingleChildScrollView(
          child: Text(replacingDraft
              ? '可以继续编辑、放弃本次未保存的修改后新建，或先把说明保存到原草稿再新建。新草稿为空，不会自动带入原草稿的文件或说明；保存与新建都不会正式提交材料。'
              : '可以先保存到当前草稿再离开，或放弃本次尚未保存的文字。保存草稿不会正式提交材料。'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'cancel'),
            child: const Text('继续编辑'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, 'discard'),
            child: Text(replacingDraft ? '放弃修改并新建' : '放弃修改并离开'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, 'save'),
            child: Text(replacingDraft ? '保存原草稿后新建' : '保存草稿并离开'),
          ),
        ],
      ),
    ),
  );

  Future<void> _replaceDraft() async {
    if (_askingToLeave || busy || _uploadUnresolved || c.draft == null || c.task == null) {
      return;
    }
    final controller = c;
    final account = controller.account;
    final userId = controller.identity?['user_id'];
    final epoch = controller.sessionEpoch;
    final taskId = controller.task!.id;
    final requirementVersion = controller.task!.requirementVersion;
    final effectiveSubmission = controller.task!.effectiveSubmission;
    final actions = List<String>.from(controller.task!.actions);
    final draftId = controller.draft!['draft_id'];
    final draftVersion = controller.draft!['draft_version'];
    final draftRequirement = controller.draft!['requirement_version'];
    final revisionOf = controller.draft!['revision_of_submission_id'];
    final fileIds = List<Object?>.from(controller.draft!['file_ids'] as List);
    final savedText = controller.draft!['text'];
    final uploadStatus = controller.uploadRecoveryStatus;
    final value = _text.text;
    bool invalidated = false;
    bool savingOriginal = false;
    Object? savedVersion;
    bool sameContext() =>
        controller.account == account &&
        controller.identity != null &&
        controller.identity?['user_id'] == userId &&
        controller.sessionEpoch == epoch &&
        controller.task?.id == taskId &&
        controller.task?.requirementVersion == requirementVersion &&
        controller.task?.effectiveSubmission == effectiveSubmission &&
        listEquals(controller.task?.actions, actions) &&
        (actions.contains('create_draft') || actions.contains('prepare_revision')) &&
        controller.draft?['draft_id'] == draftId &&
        controller.draft?['task_id'] == taskId &&
        controller.draft?['requirement_version'] == draftRequirement &&
        controller.draft?['revision_of_submission_id'] == revisionOf &&
        listEquals(controller.draft?['file_ids'] as List?, fileIds) &&
        controller.pending == null &&
        controller.uploadRecoveryStatus == uploadStatus;
    void checkContext() {
      if (!sameContext()) invalidated = true;
      final version = controller.draft?['draft_version'];
      final text = controller.draft?['text'];
      if (!savingOriginal) {
        if (version != draftVersion || text != savedText || controller.busy) {
          invalidated = true;
        }
      } else if (savedVersion != null) {
        if (version != savedVersion || text != value) invalidated = true;
      } else if (version != draftVersion) {
        // Accept only the same original draft's saved contents. Any subsequent
        // version/content change invalidates this choice, even if restored later.
        if (version is! int || draftVersion is! int ||
            version <= draftVersion || text != value) {
          invalidated = true;
        } else {
          savedVersion = version;
        }
      } else if (text != savedText) {
        invalidated = true;
      }
    }
    bool previewCurrent() =>
        !invalidated && sameContext() && !controller.busy &&
        controller.draft?['draft_version'] == draftVersion &&
        controller.draft?['text'] == savedText;
    _askingToLeave = true;
    controller.addListener(checkContext);
    try {
      if (!previewCurrent()) return;
      if (_dirty) {
        final choice = await _chooseDirtyDraftAction(
          controller: controller,
          isCurrent: previewCurrent,
          replacingDraft: true,
        );
        if (!mounted || !previewCurrent() || _text.text != value) return;
        if (choice == 'save') {
          savingOriginal = true;
          await controller.saveText(value);
          if (!mounted) return;
          checkContext();
          if (invalidated || !sameContext() || controller.busy ||
              controller.error != null || savedVersion == null ||
              controller.draft?['draft_version'] != savedVersion ||
              controller.draft?['text'] != value || _text.text != value) {
            if (sameContext()) {
              setState(() => _localError = '原草稿尚未确认保存，未建立新版本。请保留当前输入并核对后重试。');
            }
            return;
          }
          setState(() => _dirty = false);
        } else if (choice != 'discard') {
          return;
        }
      }
      if (!mounted || invalidated || !sameContext() || controller.busy) return;
      // Creating the new draft intentionally changes the pointer. Stop watching
      // only after checking the original context, immediately before that call.
      controller.removeListener(checkContext);
      await controller.createDraft();
    } finally {
      controller.removeListener(checkContext);
      _askingToLeave = false;
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _pickFile({bool bundled = false}) async {
    if (busy || _uploadUnresolved || c.draft == null) return;
    final account = c.account;
    final epoch = c.sessionEpoch;
    final taskId = c.task?.id;
    final draftId = c.draft?['draft_id'];
    final draftVersion = c.draft?['draft_version'];
    final requirementVersion = c.task?.requirementVersion;
    bool current() => mounted &&
        c.account == account && c.sessionEpoch == epoch &&
        c.task?.id == taskId && c.task?.requirementVersion == requirementVersion &&
        c.draft?['draft_id'] == draftId && c.draft?['draft_version'] == draftVersion &&
        !_uploadUnresolved && !c.busy;
    setState(() {
      _picking = true;
      _localError = null;
    });
    try {
      String name;
      Uint8List bytes;
      if (bundled) {
        final data = await rootBundle.load('assets/demo-practice.pdf');
        bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
        name = '校园实践材料_虚拟示例.pdf';
      } else {
        final file = await FilePicker.pickFile(
          type: FileType.custom,
          allowedExtensions: ['pdf'],
        );
        if (file == null || !current()) return;
        name = file.name;
        bytes = await file.readAsBytes();
      }
      if (!current()) return;
      final upload = jsonMap(c.capabilities['upload']);
      final limit = upload['max_bytes'];
      if (limit is num && bytes.length > limit) {
        throw StateError('文件大小超过当前服务限制 ${fileSize(limit)}，请选择更小的 PDF。');
      }
      await c.upload(name, bytes);
    } catch (error) {
      if (current()) setState(() => _localError = error.toString());
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  Future<void> _saveText() async {
    final value = _text.text;
    await c.saveText(value);
    if (mounted && c.draft?['text'] == value && c.error == null) {
      setState(() => _dirty = false);
    }
  }

  Future<void> _downloadFile(Json file) async {
    if (busy || file['file_id'] is! String) return;
    final account = c.account;
    final epoch = c.sessionEpoch;
    final taskId = c.task?.id;
    final draftId = c.draft?['draft_id'];
    final fileId = file['file_id'] as String;
    bool current() => mounted && c.account == account && c.identity != null &&
        c.sessionEpoch == epoch && c.task?.id == taskId &&
        c.draft?['draft_id'] == draftId &&
        (c.files.any((item) => item['file_id'] == fileId) ||
         c.savedUpload?['file_id'] == fileId);
    setState(() { _savingFile = true; _localError = null; _fileNotice = null; });
    try {
      final bytes = await c.downloadFile(fileId);
      if (bytes == null || !current()) return;
      final filename = file['filename']?.toString() ?? 'material.pdf';
      final result = await FilePicker.saveFile(
        fileName: filename,
        bytes: bytes,
        mimeType: file['mime']?.toString() ?? 'application/octet-stream',
        dialogTitle: '保存原文件',
      );
      if (!current()) return;
      setState(() => _fileNotice = kIsWeb
          ? '已发起浏览器下载，请在浏览器下载记录中查看。此操作未验证文件已落盘。'
          : result == null
              ? '已取消保存原文件，服务端文件仍保留。'
              : '系统已返回原文件保存位置。文件内容预览与解析仍未开放。');
    } catch (error) {
      if (current()) setState(() => _localError = '原文件保存未完成：$error');
    } finally {
      if (mounted) setState(() => _savingFile = false);
    }
  }

  Future<void> _openOriginalUploadTask() async {
    final target = c.savedUploadTaskId;
    final epoch = c.sessionEpoch;
    final taskId = c.task?.id;
    if (target == null || busy || !await requestLeave()) return;
    if (!mounted || c.sessionEpoch != epoch || c.task?.id != taskId || c.busy) return;
    await c.openTask(target);
  }

  bool get _draftCurrent =>
      c.draft != null &&
      c.draft!['requirement_version'] == task.requirementVersion;
  bool get _baseCurrent =>
      c.draft != null &&
      c.draft!['revision_of_submission_id'] == task.effectiveSubmission;
  bool get _checkCurrent =>
      c.check != null &&
      c.draft != null &&
      c.check!['draft_version'] == c.draft!['draft_version'] &&
      c.check!['requirement_version'] == task.requirementVersion;
  bool get _ruleBlocked =>
      _checkCurrent && c.check!['rule_status'] == 'blocked';
  List<String> get _fileIds =>
      List<String>.from(c.draft?['file_ids'] as List? ?? []);
  bool get _canSubmit =>
      !busy &&
      !_uploadUnresolved &&
      _draftCurrent &&
      _baseCurrent &&
      _fileIds.isNotEmpty &&
      !_dirty &&
      !_ruleBlocked &&
      task.actions.contains('submit');

  Future<void> _previewSubmission() async {
    if (!_canSubmit) return;
    final controller = c;
    final taskId = task.id;
    final account = c.account;
    final userId = c.identity?['user_id'];
    final epoch = c.sessionEpoch;
    final requirementVersion = task.requirementVersion;
    final draftId = c.draft!['draft_id'];
    final draftVersion = c.draft!['draft_version'];
    final effectiveSubmission = task.effectiveSubmission;
    final fileIds = List<String>.from(_fileIds);
    final title = task.title;
    final audience = task.audience;
    final deadline = task.deadlineLabel;
    final savedText = c.draft!['text']?.toString() ?? '';
    final previewFiles = List<Json>.unmodifiable(
      fileIds.map((id) {
        final matching = controller.files.where(
          (file) => file['file_id'] == id,
        );
        final file = matching.isEmpty ? <String, dynamic>{} : matching.first;
        return Map<String, dynamic>.unmodifiable({
          'file_id': id,
          'filename': file['filename']?.toString() ?? id,
          'size': file['size'],
          'state': file['state'],
        });
      }),
    );
    // This closure has no dependency on TaskPage's State or text controller:
    // the modal can remain mounted after a 401 removes the underlying page.
    bool isCurrent() =>
        controller.account == account &&
        controller.identity != null &&
        controller.identity?['user_id'] == userId &&
        controller.sessionEpoch == epoch &&
        controller.task?.id == taskId &&
        controller.task?.requirementVersion == requirementVersion &&
        controller.task?.effectiveSubmission == effectiveSubmission &&
        (controller.task?.actions.contains('submit') ?? false) &&
        controller.draft?['draft_id'] == draftId &&
        controller.draft?['draft_version'] == draftVersion &&
        controller.draft?['requirement_version'] == requirementVersion &&
        controller.draft?['revision_of_submission_id'] == effectiveSubmission &&
        controller.draft?['text'] == savedText &&
        listEquals(controller.draft?['file_ids'] as List?, fileIds) &&
        controller.pending == null &&
        controller.uploadRecoveryStatus != 'unknown' &&
        controller.uploadRecoveryStatus != 'saved_unbound';
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: paper,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
      ),
      builder: (sheetContext) => GuardedConfirmation(
        controller: controller,
        isCurrent: isCurrent,
        expiredBuilder: (_) => const ExpiredConfirmation(inDialog: false),
        builder: (sheetContext) => FractionallySizedBox(
          heightFactor: .86,
          child: Column(
            children: [
              Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.only(top: 12, bottom: 8),
                decoration: BoxDecoration(
                  color: line,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(24, 12, 24, 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SmallBadge(
                        '正式操作预览 · 演示',
                        icon: Icons.fact_check_outlined,
                      ),
                      const SizedBox(height: 18),
                      Text(
                        effectiveSubmission == null ? '核对后，再提交。' : '核对这次补交内容。',
                        style: Theme.of(sheetContext).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        '文件已保存和正式提交是两件事。请确认下列对象与材料，再创建本次提交记录。',
                        style: TextStyle(
                          fontSize: 13,
                          color: mutedInk,
                          height: 1.7,
                        ),
                      ),
                      const SizedBox(height: 20),
                      Panel(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            DetailLine('任务', title),
                            DetailLine('接收范围', audience),
                            DetailLine('期限', deadline),
                            DetailLine(
                              '版本',
                              '要求 v$requirementVersion · 草稿 v$draftVersion',
                            ),
                            if (effectiveSubmission != null)
                              DetailLine(
                                '原有效提交',
                                effectiveSubmission,
                                selectable: true,
                              ),
                          ],
                        ),
                      ),
                      SectionHeading('本次提交的 ${fileIds.length} 份材料'),
                      ...previewFiles.map(
                        (file) => Padding(
                          padding: const EdgeInsets.only(bottom: 9),
                          child: _fileRow(file, downloadable: false),
                        ),
                      ),
                      if (savedText.trim().isNotEmpty) ...[
                        const SectionHeading('已保存的说明'),
                        Panel(
                          child: Text(
                            savedText,
                            style: const TextStyle(fontSize: 13, height: 1.7),
                          ),
                        ),
                      ],
                      const SizedBox(height: 18),
                      InfoBox(
                        effectiveSubmission == null
                            ? '取得提交回执后才算提交成功。当前演示会进入人工审核状态；AI 检查不等于审核通过。'
                            : '补交成功后才切换有效版本，并重新审核。若本次失败，原有效提交仍保留。',
                        icon: Icons.verified_user_outlined,
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: EdgeInsets.fromLTRB(
                  24,
                  12,
                  24,
                  18 + MediaQuery.viewInsetsOf(sheetContext).bottom,
                ),
                child: Row(
                  children: [
                    OutlinedButton(
                      onPressed: () => Navigator.pop(sheetContext, false),
                      child: const Text('返回修改'),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: () => Navigator.pop(sheetContext, true),
                        child: Text('提交这 ${fileIds.length} 份材料'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed != true || !mounted) return;
    if (!isCurrent() || !_canSubmit) {
      setState(() => _localError = '任务、材料或账号状态已经变化，请重新核对后提交。');
      return;
    }
    await c.submit();
  }

  @override
  Widget build(BuildContext context) {
    if (c.task == null) return const SizedBox.shrink();
    final state = task.state;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_localError != null) ...[
          InfoBox(_localError!, title: '请检查后重试', warning: true),
          const SizedBox(height: 14),
        ],
        if (_fileNotice != null) ...[
          InfoBox(_fileNotice!, icon: Icons.download_done_rounded),
          const SizedBox(height: 14),
        ],
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  SmallBadge(statusLabel(task.status)),
                  SmallBadge(
                    '要求 v${task.requirementVersion}',
                    color: mutedInk,
                    background: const Color(0xFFF2F4F1),
                  ),
                  if (state['is_overdue'] == true)
                    const SmallBadge(
                      '已逾期',
                      color: warmOrange,
                      background: paleOrange,
                    ),
                ],
              ),
              const SizedBox(height: 18),
              Text(
                task.title,
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 12),
              Text(
                task.description,
                style: const TextStyle(
                  fontSize: 14,
                  height: 1.75,
                  color: mutedInk,
                ),
              ),
              const Divider(),
              DetailLine('截止时间', task.deadlineLabel),
              DetailLine('接收范围', task.audience),
            ],
          ),
        ),
        if (c.pending != null) ...[
          const SizedBox(height: 16),
          PendingOperationPanel(controller: c),
        ],
        if (c.uploadRecoveryStatus != null) ...[
          const SizedBox(height: 16),
          UploadRecoveryPanel(
            controller: c,
            onOpenOriginal: _openOriginalUploadTask,
            onDownload: !busy && c.savedUpload != null
                ? () => _downloadFile(c.savedUpload!) : null,
          ),
        ],
        const SectionHeading('你与这项任务的进度'),
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _stateRow(
                Icons.visibility_outlined,
                '阅读',
                state['read_status'] == 'read'
                    ? '已阅读 · ${chinaTime(state['read_at'])}'
                    : '尚未记录阅读',
                state['read_status'] == 'read',
              ),
              const SizedBox(height: 15),
              _stateRow(
                Icons.check_circle_outline_rounded,
                '确认',
                _confirmationLabel(state['confirmation_status']),
                state['confirmation_status'] == 'confirmed',
              ),
              const SizedBox(height: 15),
              _stateRow(
                Icons.upload_file_outlined,
                '提交',
                state['submission_status'] == 'submitted' ? '已有正式提交' : '尚未正式提交',
                state['submission_status'] == 'submitted',
              ),
              const SizedBox(height: 15),
              _stateRow(
                Icons.fact_check_outlined,
                '审核',
                _reviewLabel(state['review_status']),
                state['review_status'] == 'approved',
              ),
              if (task.actions.contains('confirm')) ...[
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: busy || c.pending != null ? null : c.confirm,
                    icon: const Icon(Icons.done_rounded, size: 18),
                    label: Text('确认已了解第 ${task.requirementVersion} 版要求'),
                  ),
                ),
              ],
            ],
          ),
        ),
        const SectionHeading('任务原文与材料要求'),
        _sourcePanel(),
        const SizedBox(height: 12),
        if (task.requirements.isEmpty)
          const InfoBox('当前任务没有已定义的材料要求，请以原文及服务端允许操作为准。')
        else
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ...task.requirements.indexed.map(
                  (entry) => Padding(
                    padding: EdgeInsets.only(top: entry.$1 == 0 ? 0 : 16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(
                              '${entry.$1 + 1}. ${entry.$2['label'] ?? '材料'}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            if (entry.$2['required'] == true)
                              const SmallBadge(
                                '必需',
                                color: warmOrange,
                                background: paleOrange,
                              ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          entry.$2['instructions']?.toString() ?? '请核对原文要求',
                          style: const TextStyle(
                            fontSize: 13,
                            color: mutedInk,
                            height: 1.6,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        SectionHeading(
          '材料工作区',
          subtitle: c.draft == null
              ? '先建立草稿，再保存文件与说明'
              : '草稿 v${c.draft!['draft_version']} · 文件保存不会自动提交',
        ),
        _draftPanel(),
        if (c.run != null) ...[const SectionHeading('检查执行记录'), _runPanel()],
        if (c.check != null) ...[const SectionHeading('材料检查结果'), _checkPanel()],
        if (c.draft != null) ...[
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _canSubmit ? _previewSubmission : null,
              icon: const Icon(Icons.fact_check_outlined, size: 20),
              label: const Text('预览材料并正式提交'),
            ),
          ),
          const SizedBox(height: 9),
          Text(
            _submitHint(),
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12, height: 1.5, color: mutedInk),
          ),
        ],
        if (c.receipt != null) ...[
          const SectionHeading('提交回执', subtitle: '这是提交时保存的结果，当前进度以上方任务状态为准'),
          _receiptPanel(
            c.receipt!,
            current: c.receipt!['submission_id'] == task.effectiveSubmission,
          ),
        ],
        const SectionHeading('提交历史', subtitle: '新版本不会覆盖原提交记录'),
        if (c.history.isEmpty)
          const EmptyState(
            title: '还没有提交记录',
            message: '正式提交成功后，回执和版本会显示在这里。',
            icon: Icons.history_rounded,
          )
        else
          ...c.history.map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _receiptPanel(
                item,
                current: item['submission_id'] == task.effectiveSubmission,
              ),
            ),
          ),
        const SizedBox(height: 14),
        const InfoBox(
          '当前接口只提供审核状态，尚未提供审核意见、审核时间与材料定位。需要补正时可建立新草稿；具体退回原因需待接口补齐后展示。',
          title: '审核信息的接入边界',
          icon: Icons.info_outline_rounded,
        ),
        const SizedBox(height: 20),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: const Text(
            '演示故障实验台',
            style: TextStyle(fontSize: 13, color: mutedInk),
          ),
          subtitle: const Text(
            '仅作用于虚拟数据',
            style: TextStyle(fontSize: 11, color: mutedInk),
          ),
          children: [ScenarioPanel(controller: c, taskActions: true)],
        ),
      ],
    );
  }

  Widget _stateRow(IconData icon, String title, String value, bool done) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Icon(icon, size: 20, color: done ? teal : mutedInk),
      const SizedBox(width: 10),
      SizedBox(
        width: 45,
        child: Text(
          title,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        ),
      ),
      Expanded(
        child: Text(
          value,
          style: TextStyle(
            fontSize: 13,
            color: done ? teal : mutedInk,
            height: 1.6,
          ),
        ),
      ),
    ],
  );

  String _confirmationLabel(dynamic status) => switch (status) {
    'confirmed' => '已主动确认',
    'not_required' => '本任务无需确认',
    _ => '等待主动确认',
  };
  String _reviewLabel(dynamic status) => switch (status) {
    'approved' => '当前版本审核通过',
    'pending' => '等待人工审核',
    'needs_revision' => '当前版本需要补正',
    'not_required' => '本任务无需审核',
    _ => '尚无正式提交，不存在审核结论',
  };

  Widget _sourcePanel() {
    final source = c.source;
    if (source == null) {
      return const InfoBox('当前尚未读取到可见原文。请刷新任务；原文缺失时不补造要求。', warning: true);
    }
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.article_outlined, color: teal, size: 18),
              const SizedBox(width: 7),
              const Expanded(
                child: Text(
                  '保留原文，方便核对',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          SelectableText(
            source['original_text']?.toString() ?? '来源仅含附件，暂无文本原文。',
            style: const TextStyle(fontSize: 13, height: 1.8, color: ink),
          ),
          const SizedBox(height: 14),
          Text(
            '采集于 ${chinaTime(source['captured_at'])} · ${source['origin'] == 'manual_text' ? '人工录入来源' : '文件来源'}',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  Widget _draftPanel() {
    final canCreate =
        task.actions.contains('create_draft') ||
        task.actions.contains('prepare_revision');
    if (c.draft == null) {
      return EmptyState(
        title: task.effectiveSubmission == null ? '从一份草稿开始' : '创建新的补交草稿',
        message: task.effectiveSubmission == null
            ? '保存材料、添加说明和检查，都在草稿里进行。'
            : '原提交仍然有效，新草稿不会覆盖它。',
        icon: Icons.note_add_outlined,
        action: canCreate
            ? FilledButton.icon(
                onPressed: busy || _uploadUnresolved ? null : c.createDraft,
                icon: const Icon(Icons.add_rounded, size: 18),
                label: Text(
                  task.effectiveSubmission == null ? '建立材料草稿' : '建立补交草稿',
                ),
              )
            : null,
      );
    }
    final upload = jsonMap(c.capabilities['upload']);
    final supported = List<String>.from(
      upload['supported_mime_types'] as List? ?? [],
    );
    final canUpload =
        !_uploadUnresolved &&
        _draftCurrent &&
        task.actions.contains('upload') &&
        upload['available'] == true &&
        supported.contains('application/pdf');
    final canCheck =
        _draftCurrent &&
        task.actions.contains('check') &&
        _fileIds.isNotEmpty &&
        !_dirty;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!_draftCurrent) ...[
            const InfoBox(
              '草稿仍引用旧要求。当前接口尚未提供完整新旧差异，请重新读取要求并建立对应草稿后继续。',
              title: '任务要求已变化',
              warning: true,
            ),
            const SizedBox(height: 16),
          ],
          if (!_baseCurrent) ...[
            const InfoBox(
              '当前有效提交已经变化，这份草稿仍基于旧提交。请核对最新回执后建立新的补交草稿，不能直接覆盖新版本。',
              title: '有效提交已更新',
              warning: true,
            ),
            const SizedBox(height: 16),
          ],
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              SmallBadge('草稿 v${c.draft!['draft_version']}'),
              SmallBadge(
                '要求 v${c.draft!['requirement_version']}',
                color: mutedInk,
                background: const Color(0xFFF2F4F1),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Text(
            c.files.isEmpty ? '还没有已保存的文件' : '已保存 ${c.files.length} 份文件',
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          if (c.files.isEmpty)
            const Text(
              '本演示先支持 PDF 上传。文件保存后会绑定当前草稿。',
              style: TextStyle(fontSize: 13, color: mutedInk, height: 1.6),
            )
          else
            ...c.files.map(
              (file) => Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _fileRow(file),
              ),
            ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 9,
            runSpacing: 9,
            children: [
              OutlinedButton.icon(
                onPressed: !busy && canUpload ? () => _pickFile() : null,
                icon: const Icon(Icons.upload_file_outlined, size: 18),
                label: const Text('选择 PDF'),
              ),
              TextButton.icon(
                onPressed: !busy && canUpload
                    ? () => _pickFile(bundled: true)
                    : null,
                icon: const Icon(Icons.description_outlined, size: 18),
                label: const Text('使用虚拟示例 PDF'),
              ),
            ],
          ),
          if (_picking)
            const Padding(
              padding: EdgeInsets.only(top: 10),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      '正在读取并保存文件…',
                      style: TextStyle(fontSize: 12, color: mutedInk),
                    ),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 8),
          Text(
            '当前上传限制：${upload['max_bytes'] == null ? '以服务端返回为准' : fileSize(upload['max_bytes'])}。预览与解析能力单独开放。',
            style: const TextStyle(fontSize: 11, color: mutedInk, height: 1.6),
          ),
          const Divider(),
          TextField(
            controller: _text,
            enabled: !busy && _draftCurrent,
            minLines: 3,
            maxLines: 6,
            onChanged: (_) => setState(() => _dirty = true),
            decoration: const InputDecoration(
              labelText: '补充说明',
              hintText: '可填写这份材料的说明；保存后再提交。',
              alignLabelWithHint: true,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: Text(
                  _dirty ? '说明文字尚未保存' : '说明已与草稿同步',
                  style: TextStyle(
                    fontSize: 12,
                    color: _dirty ? warmOrange : mutedInk,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: !busy && _dirty && _draftCurrent ? _saveText : null,
                child: const Text('保存说明'),
              ),
            ],
          ),
          const Divider(),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              OutlinedButton.icon(
                onPressed: !busy && canCheck ? c.startCheck : null,
                icon: const Icon(Icons.rule_rounded, size: 18),
                label: Text(c.check == null ? '检查这份草稿' : '重新检查草稿'),
              ),
              if (canCreate &&
                  (task.effectiveSubmission != null || !_draftCurrent))
                TextButton.icon(
                  onPressed: busy || _uploadUnresolved || _askingToLeave
                      ? null : _replaceDraft,
                  icon: const Icon(Icons.note_add_outlined, size: 18),
                  label: const Text('建立新版本草稿'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _fileRow(Json file, {bool downloadable = true}) => Container(
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      color: const Color(0xFFF5F7F4),
      borderRadius: BorderRadius.circular(13),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.picture_as_pdf_outlined, color: warmOrange, size: 25),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                file['filename']?.toString() ?? '未命名文件',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '${fileSize(file['size'])} · ${file['state'] == 'saved' ? '已保存' : '保存状态待核对'}',
                style: const TextStyle(fontSize: 11, color: mutedInk),
              ),
              if (downloadable) ...[
                const SizedBox(height: 6),
                TextButton.icon(
                  onPressed: busy ? null : () => _downloadFile(file),
                  icon: const Icon(Icons.download_outlined, size: 18),
                  label: const Text('保存原文件到设备'),
                ),
                const Text('内容预览与解析尚未开放。',
                  style: TextStyle(fontSize: 11, color: mutedInk)),
              ],
            ],
          ),
        ),
      ],
    ),
  );

  Widget _runPanel() {
    final run = c.run!;
    final status = run['status']?.toString() ?? '';
    final error = jsonMap(run['error']);
    const labels = {
      'queued': '已受理，正在排队',
      'running': '正在执行检查',
      'waiting_input': '等待补充信息',
      'cancelling': '正在取消',
      'succeeded': '本次检查执行完成',
      'failed': '本次检查未完成',
      'cancelled': '本次执行已取消',
    };
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (['queued', 'running', 'cancelling'].contains(status))
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  status == 'succeeded'
                      ? Icons.check_circle_outline_rounded
                      : Icons.info_outline_rounded,
                  size: 22,
                  color: status == 'failed' ? warmOrange : teal,
                ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  labels[status] ?? '执行状态待核对',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ...jsonList(run['steps']).map(
            (step) => Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    step['status'] == 'succeeded'
                        ? Icons.done_rounded
                        : Icons.circle_outlined,
                    size: 15,
                    color: step['status'] == 'failed' ? warmOrange : mutedInk,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      step['name']?.toString() ?? '执行步骤',
                      style: const TextStyle(fontSize: 13, color: mutedInk),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (error.isNotEmpty) ...[
            const SizedBox(height: 10),
            InfoBox(
              error['message']?.toString() ?? '执行失败，原文件和草稿仍保留。',
              warning: true,
            ),
          ],
          if (status == 'waiting_input') ...[
            const SizedBox(height: 10),
            const InfoBox(
              '服务正在等待补充。请打开执行详情，按列出的字段补充信息；原文件与草稿仍保留。',
              warning: true,
            ),
          ],
          const SizedBox(height: 12),
          DetailLine(
            '执行编号',
            run['run_id']?.toString() ?? '暂无',
            selectable: true,
          ),
          const Text(
            '执行完成不代表正式提交或审核通过。',
            style: TextStyle(fontSize: 11, color: mutedInk),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: busy ? null : () => showRunBrowser(context, c,
              runId: run['run_id'] as String),
            icon: const Icon(Icons.account_tree_outlined, size: 18),
            label: const Text('查看执行详情与恢复'),
          ),
          if (run['cancellable'] == true) ...[
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: busy ? null : c.cancelRun,
              child: const Text('请求取消执行'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _checkPanel() {
    final result = c.check!;
    final rules = jsonList(result['rule_issues']);
    final suggestions = jsonList(result['ai_suggestions']);
    final manual = jsonList(result['manual_checks']);
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!_checkCurrent) ...[
            const InfoBox(
              '草稿或要求已变化，这份检查属于旧版本。可以保留查看，但不能代表当前材料。',
              title: '检查结果已过时',
              warning: true,
            ),
            const SizedBox(height: 16),
          ],
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              SmallBadge(
                result['rule_status'] == 'passed'
                    ? '确定性规则通过'
                    : result['rule_status'] == 'blocked'
                    ? '有规则阻断项'
                    : '规则仍需核对',
                color: result['rule_status'] == 'passed' ? teal : warmOrange,
                background: result['rule_status'] == 'passed'
                    ? paleTeal
                    : paleOrange,
              ),
              SmallBadge(
                '草稿 v${result['draft_version']}',
                color: mutedInk,
                background: const Color(0xFFF2F4F1),
              ),
            ],
          ),
          const SizedBox(height: 16),
          _issues('规则问题', rules, '当前结果没有列出规则问题。', warning: true),
          const Divider(),
          _issues('AI 建议', suggestions, '没有可用的 AI 建议；不代表 AI 已完成真实解析。'),
          const Divider(),
          _issues('人工核对', manual, '当前结果未列出额外人工核对项。'),
          const SizedBox(height: 16),
          const Text(
            'AI 失败不会丢弃文件。确定性规则允许时，仍可提交进入人工审核。',
            style: TextStyle(fontSize: 12, height: 1.6, color: mutedInk),
          ),
        ],
      ),
    );
  }

  Widget _issues(
    String title,
    List<Json> issues,
    String empty, {
    bool warning = false,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        title,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 7),
      if (issues.isEmpty)
        Text(
          empty,
          style: const TextStyle(fontSize: 12, color: mutedInk, height: 1.6),
        )
      else
        ...issues.map(
          (issue) => Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  issue['message']?.toString() ?? '请核对材料',
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.7,
                    color: warning ? warmOrange : ink,
                  ),
                ),
                if (issue['field'] != null)
                  Text(
                    '位置：${issue['field']}',
                    style: const TextStyle(fontSize: 11, color: mutedInk),
                  ),
                ...jsonList(issue['evidence']).map(
                  (evidence) => Text(
                    '${evidence['location'] ?? ''} ${evidence['quote'] ?? ''}'
                        .trim(),
                    style: const TextStyle(
                      fontSize: 11,
                      height: 1.6,
                      color: mutedInk,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
    ],
  );

  String _submitHint() {
    if (c.pending != null) return '请先查清原操作结果，再决定是否发起新提交。';
    if (_uploadUnresolved) return '请先核对文件保存结果，并将原文件加入原草稿。';
    if (!_draftCurrent) return '草稿要求版本已过期，请核对新要求。';
    if (!_baseCurrent) return '有效提交已变化，请核对后建立新的补交草稿。';
    if (_dirty) return '请先保存说明文字。';
    if (_fileIds.isEmpty) return '请先保存至少一份材料。';
    if (_ruleBlocked) return '请先处理已发布要求对应的规则阻断项。';
    if (!task.actions.contains('submit')) return '当前服务端尚未允许提交，请核对确认、期限及任务状态。';
    return '下一步会展示接收范围、文件清单与要求版本。';
  }

  Widget _receiptPanel(Json receipt, {required bool current}) => Panel(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 7,
          children: [
            SmallBadge('提交 v${receipt['submission_version']}'),
            if (current)
              const SmallBadge('当前有效版本', color: teal, background: paleTeal),
            if (receipt['is_late'] == true)
              const SmallBadge('迟交', color: warmOrange, background: paleOrange),
          ],
        ),
        const SizedBox(height: 14),
        DetailLine('提交时间', chinaTime(receipt['submitted_at'])),
        DetailLine('要求版本', 'v${receipt['requirement_version']}'),
        DetailLine('审核状态', _reviewLabel(receipt['review_status'])),
        DetailLine(
          '提交编号',
          receipt['submission_id']?.toString() ?? '暂无',
          selectable: true,
        ),
        DetailLine('材料数量', '${(receipt['file_ids'] as List? ?? []).length} 份'),
      ],
    ),
  );
}
