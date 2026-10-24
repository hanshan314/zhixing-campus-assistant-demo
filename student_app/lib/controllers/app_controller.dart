import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/foundation.dart';
import '../data/api_client.dart';
import '../data/journal.dart';
import '../domain/models.dart';

class AppController extends ChangeNotifier {
  AppController({
    required this.api,
    required this.journal,
    this.pollInterval = const Duration(seconds: 2),
  });
  final ApiClient api;
  final Journal journal;
  final Duration pollInterval;
  String? account;
  Json? identity;
  Json capabilities = {};
  List<CampusTask> tasks = [];
  CampusTask? task;
  Json? source;
  Json? draft;
  List<Json> files = [];
  Json? check;
  Json? run;
  List<Json> runs = [];
  List<Json> notifications = [];
  bool notificationsLoaded = false;
  Json? profile;
  bool profileLoaded = false;
  Json? selectedRun;
  Timer? _selectedRunPoll;
  int _selectedRunGeneration = 0;
  List<Json> history = [];
  Json? receipt;
  PendingOperation? pending;
  Json? savedUpload;
  Json? _savedUploadRecord;
  String? get savedUploadDraftId => _savedUploadRecord?['draft_id'] as String?;
  String? get savedUploadTaskId => _savedUploadRecord?['task_id'] as String?;
  String? uploadRecoveryStatus;
  int get sessionEpoch => api.epoch;
  bool canRetryOriginal = false;
  bool busy = false;
  bool initialized = false;
  bool connected = false;
  String? error;
  String? notice;
  int _homeGeneration = 0;
  int _detailGeneration = 0;
  int _sessionTransition = 0;
  int _operationGeneration = 0;
  int _pollGeneration = 0;
  Timer? _poll;
  bool _disposed = false;

  String get _scope => 'demo:${api.origin}:$account';
  String _key(String suffix) => '$_scope:$suffix';
  void _emit() {
    if (!_disposed) notifyListeners();
  }

  String _operationKey() {
    final random = Random.secure();
    return 'demo_${List.generate(24, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
  }

  void _ensure(int epoch) {
    if (epoch != api.epoch) throw StaleSession();
  }

  Json _map(dynamic value) => Map<String, dynamic>.from(value as Map);
  List<Json> _items(Json value) => (value['items'] as List).map(_map).toList();

  Future<void> initialize() async {
    try {
      final saved = await journal.read('selected_demo_account');
      final selected = saved?['account'];
      if (selected == 'a' || selected == 'b') await login(selected as String);
    } catch (exception) {
      error = '无法读取本地演示状态：$exception';
    } finally {
      initialized = true;
      _emit();
    }
  }

  void _clearViews() {
    _operationGeneration++;
    _pollGeneration++;
    _poll?.cancel();
    _homeGeneration++;
    _detailGeneration++;
    identity = null;
    capabilities = {};
    tasks = [];
    task = null;
    source = null;
    draft = null;
    files = [];
    check = null;
    run = null;
    runs = [];
    notifications = [];
    notificationsLoaded = false;
    profile = null;
    profileLoaded = false;
    selectedRun = null;
    _selectedRunGeneration++;
    _selectedRunPoll?.cancel();
    history = [];
    receipt = null;
    pending = null;
    savedUpload = null;
    _savedUploadRecord = null;
    uploadRecoveryStatus = null;
    canRetryOriginal = false;
    connected = false;
    notice = null;
  }

  Future<void> login(String selected) async {
    if (!['a', 'b'].contains(selected)) return;
    final transition = ++_sessionTransition;
    void ensureTransition() {
      if (transition != _sessionTransition) throw StaleSession();
    }

    final previousAccount = account;
    // Invalidate all in-flight requests before storage work or painting a new user.
    api.useDemoAccount(null);
    _clearViews();
    account = null;
    busy = true;
    error = null;
    _emit();
    try {
      final saved = await journal.read('selected_demo_account');
      ensureTransition();
      final prior = previousAccount ?? saved?['account'];
      if (prior != null && prior != selected) {
        await journal.clear(preservePendingOperations: true);
      }
      ensureTransition();
      account = selected;
      api.useDemoAccount(selected);
      final epoch = api.epoch;
      await journal.write('selected_demo_account', {'account': selected});
      _ensure(epoch);
      final stored = await journal.read(_key('pending'));
      _ensure(epoch);
      if (stored?['operation'] is Map) {
        pending = PendingOperation.fromJson(_map(stored!['operation']));
      }
      final savedFile = await journal.read(_key('saved_upload'));
      _ensure(epoch);
      if (savedFile?['file'] is Map) {
        _savedUploadRecord = savedFile;
        savedUpload = _map(savedFile!['file']);
        uploadRecoveryStatus =
            savedFile['status'] as String? ?? 'saved_unbound';
      }
      if (pending?.action == 'upload_file') uploadRecoveryStatus = 'unknown';
      await _loadHome();
      _ensure(epoch);
      if (pending != null) notice = '发现一项待核对操作，请查询原结果，勿重复提交。';
    } on StaleSession {
      return;
    } catch (exception) {
      _showError(exception);
    } finally {
      if (transition == _sessionTransition) {
        busy = false;
        initialized = true;
        _emit();
      }
    }
  }

  Future<void> logout() async {
    final transition = ++_sessionTransition;
    api.useDemoAccount(null);
    _clearViews();
    account = null;
    busy = true;
    error = null;
    _emit();
    try {
      await journal.clear(preservePendingOperations: true);
    } catch (exception) {
      if (transition == _sessionTransition) {
        error = '本地清理未完成，请重新启动后核对；私人页面已锁定。$exception';
      }
    } finally {
      if (transition == _sessionTransition) {
        busy = false;
        _emit();
      }
    }
  }

  void _showError(Object exception) {
    if (exception is ApiFailure && exception.status == 401) {
      _clearViews();
      busy = false;
      // Keep account marker for a same-user reauthentication, but no private views.
      error = '会话已过期，请重新选择演示身份。原操作不会自动重发。';
      _emit();
      return;
    }
    error = exception is ApiFailure
        ? '${exception.message}${exception.requestId == null ? '' : '\n请求编号：${exception.requestId}'}'
        : '操作未完成：$exception';
  }

  Future<void> _perform(Future<void> Function(int epoch) operation) async {
    if (busy || identity == null) return;
    final epoch = api.epoch;
    final operationTicket = ++_operationGeneration;
    busy = true;
    error = null;
    notice = null;
    _emit();
    try {
      await operation(epoch);
    } on StaleSession {
      // Old user/detail data must never reappear after session invalidation.
    } catch (exception) {
      if (operationTicket == _operationGeneration &&
          (epoch == api.epoch ||
              (exception is ApiFailure && exception.status == 401))) {
        _showError(exception);
      }
    } finally {
      if (operationTicket == _operationGeneration && epoch == api.epoch) {
        busy = false;
        _emit();
      }
    }
  }

  Future<List<Json>> _allPages(String path) async {
    final result = <Json>[];
    final seen = <String>{};
    String? cursor;
    for (var page = 0; page < 100; page++) {
      final uri = cursor == null
          ? path
          : '$path${path.contains('?') ? '&' : '?'}cursor=${Uri.encodeQueryComponent(cursor)}';
      final data = await api.request('GET', uri);
      result.addAll(_items(data));
      if (data['has_more'] == false) return result;
      cursor = data['next_cursor'] as String?;
      if (cursor == null || !seen.add(cursor)) {
        throw ApiFailure('PAGINATION_ERROR', '列表分页不完整，请重新查询。');
      }
    }
    throw ApiFailure('PAGINATION_LIMIT', '任务数量超过当前演示读取上限，未显示不完整计数。');
  }

  Future<void> _loadHome() async {
    final generation = ++_homeGeneration;
    final epoch = api.epoch;
    final me = await api.request('GET', '/v1/me');
    final caps = await api.request('GET', '/v1/capabilities');
    final rows = await _allPages('/v1/me/tasks');
    _ensure(epoch);
    if (generation != _homeGeneration) return;
    identity = me;
    capabilities = caps;
    tasks = rows.map(CampusTask.new).toList();
    connected = true;
  }

  Future<void> refresh() async {
    if (identity == null && account != null) {
      await login(account!);
      return;
    }
    await _perform((epoch) async {
      final selected = task?.id;
      await _loadHome();
      if (selected != null) await _loadDetail(selected);
    });
  }

  Future<void> openTask(String taskId) => _perform((epoch) async {
    leaveTask();
    await _loadDetail(taskId);
    _ensure(epoch);
    final selected = task;
    if (selected != null && selected.actions.contains('read')) {
      await api.request(
        'POST',
        '/v1/tasks/$taskId/read',
        body: {'requirement_version': selected.requirementVersion},
      );
      await _loadDetail(taskId);
      await _loadHome();
    }
  });

  Future<void> _loadDetail(String id) async {
    final ticket = ++_detailGeneration;
    final epoch = api.epoch;
    final current = CampusTask(await api.request('GET', '/v1/tasks/$id'));
    final previous = await _allPages('/v1/tasks/$id/my-submissions');
    Json? loadedSource;
    final ids = List<String>.from(current.wire['source_ids'] as List);
    if (ids.isNotEmpty) {
      loadedSource = await api.request('GET', '/v1/sources/${ids.first}');
    }
    final pointer = await journal.read(_key('draft:$id'));
    _ensure(epoch);
    Json? loadedDraft;
    Json? loadedCheck;
    Json? loadedRun;
    final loadedFiles = <Json>[];
    if (pointer?['draft_id'] is String) {
      try {
        loadedDraft = await api.request(
          'GET',
          '/v1/submission-drafts/${pointer!['draft_id']}',
        );
      } on ApiFailure catch (failure) {
        if (failure.status != 404) rethrow;
        await journal.write(_key('draft:$id'), {});
        _ensure(epoch);
      }
      if (loadedDraft != null) {
        // Submitted drafts cannot be silently reused as a new submission intent.
        final savedDraft = loadedDraft;
        final alreadySubmitted = previous.any(
          (item) =>
              item['draft_id'] == savedDraft['draft_id'] &&
              item['draft_version'] == savedDraft['draft_version'],
        );
        if (alreadySubmitted && pending == null) loadedDraft = null;
        if (loadedDraft != null) {
          for (final fileId in List<String>.from(
            loadedDraft['file_ids'] as List,
          )) {
            loadedFiles.add(await api.request('GET', '/v1/files/$fileId'));
          }
          if (loadedDraft['current_check_id'] != null) {
            loadedCheck = await api.request(
              'GET',
              '/v1/checks/${loadedDraft['current_check_id']}',
            );
          }
          final runPointer = await journal.read(
            _key('run:${loadedDraft['draft_id']}'),
          );
          _ensure(epoch);
          if (runPointer?['run_id'] is String) {
            loadedRun = await api.request(
              'GET',
              '/v1/runs/${runPointer!['run_id']}',
            );
          }
        }
      }
    }
    _ensure(epoch);
    if (ticket != _detailGeneration) return;
    task = current;
    history = previous;
    source = loadedSource;
    draft = loadedDraft;
    check = loadedCheck;
    run = loadedRun;
    files = loadedFiles;
    if (loadedRun != null &&
        ![
          'succeeded',
          'failed',
          'cancelled',
          'waiting_input',
        ].contains(loadedRun['status'])) {
      _schedulePoll(loadedRun['run_id'] as String, id, epoch);
    }
    _emit();
  }

  void leaveTask() {
    _detailGeneration++;
    _pollGeneration++;
    _poll?.cancel();
    task = null;
    source = null;
    draft = null;
    files = [];
    check = null;
    run = null;
    history = [];
    receipt = null;
    _emit();
  }

  Future<void> _storePending(PendingOperation operation) async {
    final epoch = api.epoch;
    await journal.write(_key('pending'), {'operation': operation.toJson()});
    _ensure(epoch);
    pending = operation;
    canRetryOriginal = false;
  }

  Future<void> _clearPending() async {
    final epoch = api.epoch;
    await journal.write(_key('pending'), {});
    _ensure(epoch);
    pending = null;
    canRetryOriginal = false;
  }

  Future<Json> _formal(PendingOperation operation) async {
    if (pending != null) {
      throw ApiFailure('UNRESOLVED_OPERATION', '请先查询已有操作的结果。');
    }
    await _storePending(
      operation,
    ); // An awaited durable commit must precede the network write.
    return _sendOriginal(operation);
  }

  Future<Json> _sendOriginal(PendingOperation operation) async {
    canRetryOriginal = false;
    final selectedGeneration = _selectedRunGeneration;
    try {
      final result = operation.action == 'upload_file'
          ? await api.upload(
              operation.targetId,
              operation.multipart!['filename'] as String,
              operation.originalUploadBytes(),
              operation.key,
              mime: operation.multipart!['mime'] as String,
            )
          : await api.request(
              'POST',
              operation.path,
              body: operation.body,
              key: operation.key,
            );
      if (operation.action == 'upload_file') {
        await _saveUploadedFile(operation, result);
      }
      if (operation.action == 'submit_materials') receipt = result;
      if (operation.action == 'start_check') {
        await _saveRun(operation.targetId, result);
      }
      if (_isRunControl(operation.action)) {
        await _applyRunControl(
          operation,
          result,
          expectedGeneration: selectedGeneration,
        );
      }
      if (operation.action == 'read_notification') {
        notifications = [
          result,
          ...notifications.where(
            (item) => item['notification_id'] != result['notification_id'],
          ),
        ];
      }
      await _clearPending();
      notice = switch (operation.action) {
        'submit_materials' => '已取得正式提交回执。',
        'start_check' => '检查已受理。AI 未接通，规则检查与人工核对分别展示。',
        'upload_file' => '文件已保存，尚未正式提交。',
        'retry_run' => '新的执行已受理，原执行记录保留。',
        'supply_run_input' => '补充已受理，请继续查看执行结果。',
        'cancel_run' => '取消请求已受理，最终状态以服务端查询为准。',
        'read_notification' => '消息已读。任务确认和提交状态分别保存。',
        _ => '已确认当前任务要求。',
      };
      return result;
    } on ApiFailure catch (failure) {
      if (failure.definitiveRejection) {
        await _clearPending();
        if (operation.action == 'upload_file') uploadRecoveryStatus = 'failed';
      } else {
        if (operation.action == 'upload_file') uploadRecoveryStatus = 'unknown';
        notice = '操作结果待核对。已保留原操作键和参数，请查询原结果。';
      }
      rethrow;
    }
  }

  Future<void> confirm() => _perform((epoch) async {
    final selected = task;
    if (selected == null || !selected.actions.contains('confirm')) return;
    await _formal(
      PendingOperation(
        key: _operationKey(),
        action: 'confirm_notice',
        targetId: selected.id,
        path: '/v1/tasks/${selected.id}/confirm',
        body: {'requirement_version': selected.requirementVersion},
      ),
    );
    await _loadDetail(selected.id);
    await _loadHome();
  });

  Future<void> createDraft() => _perform((epoch) async {
    final selected = task;
    if (selected == null ||
        pending != null ||
        uploadRecoveryStatus == 'saved_unbound') {
      return;
    }
    if (!selected.actions.contains('create_draft') &&
        !selected.actions.contains('prepare_revision')) {
      return;
    }
    final value = await api.request(
      'POST',
      '/v1/tasks/${selected.id}/submission-drafts',
      body: {
        'requirement_version': selected.requirementVersion,
        'file_ids': <String>[],
        'text': '',
        'revision_of_submission_id': selected.effectiveSubmission,
      },
    );
    await journal.write(_key('draft:${selected.id}'), {
      'draft_id': value['draft_id'],
    });
    _ensure(epoch);
    receipt = null;
    await _loadDetail(selected.id);
    notice = '草稿已保存。此时尚未正式提交。';
  });

  Future<void> saveText(String value) => _perform((epoch) async {
    if (draft == null || task == null) return;
    final current = Map<String, dynamic>.from(draft!);
    await api.request(
      'PATCH',
      '/v1/submission-drafts/${current['draft_id']}',
      body: {
        'draft_version': current['draft_version'],
        'requirement_version': current['requirement_version'],
        'file_ids': current['file_ids'],
        'text': value,
      },
    );
    await _loadDetail(task!.id);
    notice = '草稿已更新，旧检查结果已失效。';
  });

  Future<void> upload(String filename, Uint8List bytes) =>
      _perform((epoch) async {
        if (task == null ||
            draft == null ||
            pending != null ||
            uploadRecoveryStatus == 'saved_unbound') {
          return;
        }
        final selected = task!;
        final current = Map<String, dynamic>.from(draft!);
        final max = (capabilities['upload'] as Map?)?['max_bytes'] as int?;
        if (max != null && bytes.length > max) {
          throw ApiFailure('FILE_TOO_LARGE', '文件超过当前服务允许的大小。');
        }
        if (!filename.toLowerCase().endsWith('.pdf')) {
          throw ApiFailure('FILE_TYPE_UNSUPPORTED', '当前演示任务仅接收 PDF 测试材料。');
        }
        if (bytes.isEmpty) throw ApiFailure('VALIDATION_FAILED', '不能上传空文件。');
        final uploadCapability = capabilities['upload'] as Map?;
        if (uploadCapability?['available'] == false) {
          throw ApiFailure('CAPABILITY_UNAVAILABLE', '当前服务未开放上传。');
        }
        final formats = uploadCapability?['supported_mime_types'] as List?;
        if (formats != null && !formats.contains('application/pdf')) {
          throw ApiFailure('FILE_TYPE_UNSUPPORTED', '当前服务不支持 PDF 材料。');
        }
        for (final requirement in selected.requirements.where(
          (item) => item['kind'] == 'file',
        )) {
          final allowed = requirement['accepted_mime_types'] as List?;
          final limit = requirement['max_bytes'] as int?;
          if (allowed != null &&
              allowed.isNotEmpty &&
              !allowed.contains('application/pdf')) {
            throw ApiFailure('FILE_TYPE_UNSUPPORTED', 'PDF 不符合当前任务的材料格式要求。');
          }
          if (limit != null && bytes.length > limit) {
            throw ApiFailure('FILE_TOO_LARGE', '文件超过当前任务材料上限。');
          }
        }
        final operation = PendingOperation(
          key: _operationKey(),
          action: 'upload_file',
          targetId: selected.id,
          path: '/v1/files',
          body: {'purpose': 'submission_material', 'task_id': selected.id},
          multipart: {
            'filename': filename,
            'mime': 'application/pdf',
            'size': bytes.length,
            'bytes_base64': base64Encode(bytes),
            'content_sha256': uploadDigest(bytes),
          },
          recovery: {
            'draft_id': current['draft_id'],
            'task_id': selected.id,
            'draft_version': current['draft_version'],
            'requirement_version': current['requirement_version'],
            'expected_effective_submission_id': selected.effectiveSubmission,
          },
        );
        uploadRecoveryStatus = 'unknown';
        try {
          await _formal(operation);
        } catch (_) {
          if (epoch == api.epoch && pending == null) {
            uploadRecoveryStatus = 'failed';
          }
          rethrow;
        }
        _ensure(epoch);
        await _bindSavedUpload(epoch, allowChangedVersion: false);
        await _loadDetail(selected.id);
        notice = '文件已保存并绑定草稿，尚未正式提交。';
      });

  Future<void> _saveUploadedFile(PendingOperation operation, Json file) async {
    final epoch = api.epoch;
    if (operation.recovery == null || !operation.canReplayUpload) {
      throw ApiFailure('LEGACY_UPLOAD', '原上传缺少可靠草稿绑定信息，请保留原记录人工核对，不能自动重发。');
    }
    if (file['file_id'] is! String ||
        file['state'] != 'saved' ||
        file['content_hash'] != operation.multipart!['content_sha256']) {
      throw ApiFailure('RECEIPT_MISMATCH', '文件回执与原材料不匹配，请继续核对原操作。');
    }
    final record = {
      ...operation.recovery!,
      'file': file,
      'status': 'saved_unbound',
      'operation_key': operation.key,
      'contract_version': operation.contractVersion,
    };
    await journal.write(_key('saved_upload'), record);
    _ensure(epoch);
    _savedUploadRecord = record;
    savedUpload = Map<String, dynamic>.unmodifiable(file);
    uploadRecoveryStatus = 'saved_unbound';
  }

  Future<void> _markUploadBound(Json record) async {
    final epoch = api.epoch;
    final updated = {...record, 'status': 'bound'};
    await journal.write(_key('saved_upload'), updated);
    _ensure(epoch);
    _savedUploadRecord = updated;
    uploadRecoveryStatus = 'bound';
  }

  Future<void> _restoreUploadDraftPointer(Json record, int epoch) async {
    final pointerKey = _key('draft:${record['task_id']}');
    final pointer = await journal.read(pointerKey);
    _ensure(epoch);
    if (pointer?['draft_id'] != null &&
        pointer!['draft_id'] != record['draft_id']) {
      throw ApiFailure(
        'RESOURCE_VERSION_CONFLICT',
        '本机已选择另一份草稿。原文件仍保留，请先核对原草稿，不能覆盖当前草稿索引。',
      );
    }
    await journal.write(pointerKey, {'draft_id': record['draft_id']});
    _ensure(epoch);
  }

  Future<void> _bindSavedUpload(
    int epoch, {
    bool allowChangedVersion = true,
  }) async {
    final record = _savedUploadRecord;
    final file = savedUpload;
    if (record == null || file == null || pending != null) return;
    final taskId = record['task_id'] as String;
    final draftId = record['draft_id'] as String;
    final pointer = await journal.read(_key('draft:$taskId'));
    _ensure(epoch);
    if (pointer?['draft_id'] != null && pointer!['draft_id'] != draftId) {
      throw ApiFailure(
        'RESOURCE_VERSION_CONFLICT',
        '当前草稿与原文件目标不同，请先核对原草稿；不会覆盖或改绑文件。',
      );
    }
    final original = await api.request('GET', '/v1/submission-drafts/$draftId');
    final currentTask = CampusTask(
      await api.request('GET', '/v1/tasks/$taskId'),
    );
    _ensure(epoch);
    if (original['task_id'] != taskId ||
        original['requirement_version'] != record['requirement_version'] ||
        currentTask.requirementVersion != record['requirement_version'] ||
        currentTask.effectiveSubmission !=
            record['expected_effective_submission_id']) {
      throw ApiFailure(
        'RESOURCE_VERSION_CONFLICT',
        '原草稿、要求或有效提交已变化；文件仍已保存，请先核对原任务。',
      );
    }
    final ids = List<String>.from(original['file_ids'] as List);
    if (ids.contains(file['file_id'])) {
      await _restoreUploadDraftPointer(record, epoch);
      await _markUploadBound(record);
      return;
    }
    if (!currentTask.actions.contains('upload')) {
      throw ApiFailure('NOT_ALLOWED', '原任务当前不允许绑定材料；文件仍已保存。');
    }
    if (!allowChangedVersion &&
        original['draft_version'] != record['draft_version']) {
      throw ApiFailure(
        'RESOURCE_VERSION_CONFLICT',
        '上传期间原草稿已变化。文件已保存，请刷新核对后明确重新绑定。',
      );
    }
    final version = original['draft_version'];
    try {
      await api.request(
        'PATCH',
        '/v1/submission-drafts/$draftId',
        body: {
          'draft_version': version,
          'requirement_version': original['requirement_version'],
          'file_ids': [...ids, file['file_id']],
          'text': original['text'],
        },
      );
      _ensure(epoch);
      await _restoreUploadDraftPointer(record, epoch);
      await _markUploadBound(record);
    } on ApiFailure {
      // PATCH has no idempotency guarantee. Read after failure; never blindly repeat it.
      final verified = await api.request(
        'GET',
        '/v1/submission-drafts/$draftId',
      );
      _ensure(epoch);
      if (verified['task_id'] == taskId &&
          (verified['file_ids'] as List).contains(file['file_id'])) {
        await _restoreUploadDraftPointer(record, epoch);
        await _markUploadBound(record);
        return;
      }
      notice = '文件已保存，但尚未绑定原草稿。请刷新核对后重试绑定，不需要重新上传。';
      rethrow;
    }
  }

  Future<void> bindSavedUpload() => _perform((epoch) async {
    if (uploadRecoveryStatus != 'saved_unbound' || pending != null) return;
    final target = _savedUploadRecord?['task_id'] as String?;
    await _bindSavedUpload(epoch);
    if (target != null && task?.id == target) await _loadDetail(target);
    notice = '已核对原文件并绑定原草稿，尚未正式提交。';
  });

  Future<Uint8List?> downloadFile(String fileId) async {
    Uint8List? result;
    await _perform((epoch) async {
      final bytes = await api.downloadFile(fileId);
      _ensure(epoch);
      result = bytes;
      notice = '已取得原文件；此操作不表示已完成内容预览或解析。';
    });
    return result;
  }

  Future<void> _saveRun(String draftId, Json value) async {
    final epoch = api.epoch;
    await journal.write(_key('run:$draftId'), {'run_id': value['run_id']});
    _ensure(epoch);
    run = value;
  }

  Future<void> startCheck() => _perform((epoch) async {
    if (draft == null || task == null || pending != null) return;
    final current = Map<String, dynamic>.from(draft!);
    _pollGeneration++;
    _poll?.cancel();
    final value = await _formal(
      PendingOperation(
        key: _operationKey(),
        action: 'start_check',
        targetId: current['draft_id'] as String,
        path: '/v1/submission-drafts/${current['draft_id']}/checks',
        body: {
          'draft_version': current['draft_version'],
          'requirement_version': current['requirement_version'],
        },
      ),
    );
    _ensure(epoch);
    _schedulePoll(value['run_id'] as String, task!.id, epoch);
  });

  void _schedulePoll(String runId, String taskId, int epoch) {
    _poll?.cancel();
    final ticket = ++_pollGeneration;
    final pollingRun = run;
    if (pollingRun == null ||
        [
          'succeeded',
          'failed',
          'cancelled',
          'waiting_input',
        ].contains(pollingRun['status'])) {
      return;
    }
    final seconds = pollingRun['run_id'] == runId
        ? pollingRun['poll_after_seconds']
        : null;
    final delay = seconds is int ? Duration(seconds: seconds) : pollInterval;
    _poll = Timer(delay, () async {
      if (_disposed ||
          epoch != api.epoch ||
          task?.id != taskId ||
          ticket != _pollGeneration) {
        return;
      }
      try {
        final value = await api.request('GET', '/v1/runs/$runId');
        if (epoch != api.epoch ||
            task?.id != taskId ||
            ticket != _pollGeneration) {
          return;
        }
        run = value;
        if (['succeeded', 'failed', 'cancelled'].contains(value['status'])) {
          await _loadDetail(taskId);
          if (value['status'] == 'failed') {
            notice = 'AI 检查未完成，文件仍保留；确定性规则允许时可以交人工审核。';
          }
        } else if (value['status'] != 'waiting_input') {
          _schedulePoll(runId, taskId, epoch);
        }
        _emit();
      } on StaleSession {
        return;
      } catch (exception) {
        if (epoch != api.epoch || ticket != _pollGeneration) return;
        _showError(exception);
        _emit();
      }
    });
  }

  Future<void> cancelRun() => _perform((epoch) async {
    final current = selectedRun ?? run;
    if (current == null || current['cancellable'] != true || pending != null) {
      return;
    }
    _pollGeneration++;
    _poll?.cancel();
    await _controlRun(current, 'cancel_run', 'cancel');
  });

  bool _isRunControl(String action) =>
      ['retry_run', 'cancel_run', 'supply_run_input'].contains(action);

  Future<void> _applyRunControl(
    PendingOperation operation,
    Json value, {
    int? expectedGeneration,
  }) async {
    final epoch = api.epoch;
    final id = value['run_id'];
    if (id is! String ||
        (operation.action == 'retry_run'
            ? id == operation.targetId ||
                  value['retry_of'] != operation.targetId
            : id != operation.targetId)) {
      throw ApiFailure('RECEIPT_MISMATCH', '执行回执与原操作不匹配，请保留原操作查询。');
    }
    final draftId = operation.recovery?['draft_id'];
    if (draftId is String) {
      await journal.write(_key('run:$draftId'), {'run_id': id});
      _ensure(epoch);
      if (draft?['draft_id'] == draftId) run = value;
    } else if (run?['run_id'] == operation.targetId) {
      run = value;
    }
    runs = [value, ...runs.where((item) => item['run_id'] != id)];
    if (run?['run_id'] == id && task != null) {
      _schedulePoll(id, task!.id, epoch);
    }
    if (expectedGeneration == null ||
        expectedGeneration == _selectedRunGeneration) {
      selectedRun = value;
      _scheduleSelectedRun(epoch);
    }
  }

  Future<void> _controlRun(
    Json current,
    String action,
    String suffix, {
    List<Json>? inputs,
  }) async {
    _selectedRunPoll?.cancel();
    _selectedRunGeneration++;
    final operation = PendingOperation(
      key: _operationKey(),
      action: action,
      targetId: current['run_id'] as String,
      path:
          '/v1/runs/${Uri.encodeComponent(current['run_id'] as String)}/$suffix',
      body: {
        'resource_version': current['resource_version'],
        'inputs': ?inputs,
      },
      recovery: {
        if (run?['run_id'] == current['run_id'] && draft != null)
          'draft_id': draft!['draft_id'],
      },
    );
    final selectedGeneration = _selectedRunGeneration;
    try {
      await _formal(operation);
    } on ApiFailure catch (failure) {
      if (failure.status == 409 && failure.code != 'IDEMPOTENCY_KEY_REUSED') {
        final value = await api.request(
          'GET',
          '/v1/runs/${Uri.encodeComponent(operation.targetId)}',
        );
        runs = [
          value,
          ...runs.where((item) => item['run_id'] != value['run_id']),
        ];
        if (selectedGeneration == _selectedRunGeneration) {
          selectedRun = value;
          _scheduleSelectedRun(api.epoch);
        }
      }
      rethrow;
    }
  }

  Future<void> loadRuns() => _perform((epoch) async {
    final items = await _allPages('/v1/me/runs');
    _ensure(epoch);
    runs = items;
  });

  Future<void> _loadNotifications(int epoch) async {
    final items = await _allPages('/v1/me/notifications');
    _ensure(epoch);
    final ids = <String>{};
    notifications = items
        .where(
          (item) => ids.add('${item['recipient_user_id']}:${item['event_id']}'),
        )
        .toList();
    notificationsLoaded = true;
  }

  Future<void> loadNotifications() => _perform(_loadNotifications);

  Future<Json> _readNotification(String notificationId) async {
    final value = await api.request(
      'GET',
      '/v1/notifications/${Uri.encodeComponent(notificationId)}',
    );
    if (value['read_status'] == 'read') return value;
    return _formal(
      PendingOperation(
        key: _operationKey(),
        action: 'read_notification',
        targetId: notificationId,
        path: '/v1/notifications/${Uri.encodeComponent(notificationId)}/read',
        body: {'resource_version': value['resource_version']},
      ),
    );
  }

  Future<void> readNotification(String notificationId) =>
      _perform((epoch) async {
        if (pending != null) {
          throw ApiFailure('UNRESOLVED_OPERATION', '请先查询已有原操作结果。');
        }
        await _readNotification(notificationId);
        await _loadNotifications(epoch);
      });

  Future<void> openNotification(String notificationId) async {
    String? target;
    final epoch = api.epoch;
    await _perform((generation) async {
      if (pending != null) {
        throw ApiFailure('UNRESOLVED_OPERATION', '请先查询已有原操作结果。');
      }
      final message = await _readNotification(notificationId);
      final reference = _map(message['target']);
      if (reference['kind'] != 'task') {
        throw ApiFailure('UNSUPPORTED_OPERATION', '当前版本尚未开放此类消息目标。');
      }
      await _loadNotifications(generation);
      target = reference['id'] as String;
    });
    if (target != null && epoch == api.epoch && identity != null) {
      await openTask(target!);
    }
  }

  Future<void> loadProfile() => _perform((epoch) async {
    final value = await api.request('GET', '/v1/me/profile');
    _ensure(epoch);
    if (value['user_id'] != identity?['user_id']) {
      throw ApiFailure('SCOPE_MISMATCH', '本人资料与当前身份不一致，已停止展示。');
    }
    profile = value;
    profileLoaded = true;
  });

  Future<void> openRun(String runId) => _perform((epoch) async {
    final generation = ++_selectedRunGeneration;
    _selectedRunPoll?.cancel();
    final value = await api.request(
      'GET',
      '/v1/runs/${Uri.encodeComponent(runId)}',
    );
    _ensure(epoch);
    if (generation != _selectedRunGeneration) return;
    selectedRun = value;
    _scheduleSelectedRun(epoch);
  });

  void closeRun() {
    _selectedRunGeneration++;
    _selectedRunPoll?.cancel();
    selectedRun = null;
    _emit();
  }

  void _scheduleSelectedRun(int epoch) {
    _selectedRunPoll?.cancel();
    final value = selectedRun;
    final generation = ++_selectedRunGeneration;
    if (value == null ||
        [
          'succeeded',
          'failed',
          'cancelled',
          'waiting_input',
        ].contains(value['status'])) {
      return;
    }
    final runId = value['run_id'] as String;
    final seconds = value['poll_after_seconds'];
    _selectedRunPoll = Timer(
      seconds is int ? Duration(seconds: seconds) : pollInterval,
      () async {
        try {
          final updated = await api.request(
            'GET',
            '/v1/runs/${Uri.encodeComponent(runId)}',
          );
          _ensure(epoch);
          if (_disposed ||
              generation != _selectedRunGeneration ||
              selectedRun?['run_id'] != runId) {
            return;
          }
          selectedRun = updated;
          runs = [updated, ...runs.where((item) => item['run_id'] != runId)];
          if (run?['run_id'] == runId) {
            run = updated;
            if (task != null &&
                [
                  'succeeded',
                  'failed',
                  'cancelled',
                ].contains(updated['status'])) {
              await _loadDetail(task!.id);
              _ensure(epoch);
              if (_disposed || generation != _selectedRunGeneration) return;
            }
          }
          _scheduleSelectedRun(epoch);
          _emit();
        } on StaleSession {
          return;
        } catch (exception) {
          if (_disposed ||
              epoch != api.epoch ||
              generation != _selectedRunGeneration) {
            return;
          }
          _showError(exception);
          _emit();
        }
      },
    );
  }

  Future<void> supplyRunInputs(List<Json> inputs) => _perform((epoch) async {
    final current = selectedRun;
    if (current == null ||
        current['status'] != 'waiting_input' ||
        pending != null) {
      return;
    }
    final snapshot = _map(jsonDecode(jsonEncode(current)));
    final values = jsonDecode(jsonEncode(inputs)) as List;
    final fields = (snapshot['input_fields'] as List).map(_map).toList();
    final names = <String>{};
    for (final value in values) {
      final item = _map(value);
      if (item.keys.toSet().difference({'name', 'value'}).isNotEmpty ||
          item['name'] is! String ||
          item['value'] is! String ||
          !names.add(item['name'] as String) ||
          !fields.any((field) => field['name'] == item['name'])) {
        throw ApiFailure('VALIDATION_FAILED', '请只补充服务端要求的字段，不要重复。');
      }
    }
    for (final field in fields) {
      final matching = values.cast<Map>().where(
        (item) => item['name'] == field['name'],
      );
      if (field['required'] == true &&
          (matching.isEmpty ||
              (matching.first['value'] as String).trim().isEmpty)) {
        throw ApiFailure('VALIDATION_FAILED', '请填写${field['label']}。');
      }
      if (field['type'] == 'choice' &&
          matching.isNotEmpty &&
          !(field['choices'] as List).contains(matching.first['value'])) {
        throw ApiFailure('VALIDATION_FAILED', '请选择允许的选项。');
      }
    }
    await _controlRun(
      snapshot,
      'supply_run_input',
      'inputs',
      inputs: values.map(_map).toList(),
    );
  });

  Future<void> retryRun() => _perform((epoch) async {
    final current = selectedRun ?? run;
    if (current == null || pending != null) return;
    if (current['status'] != 'cancelled' &&
        !(current['status'] == 'failed' &&
            (current['error'] as Map?)?['retryable'] == true)) {
      throw ApiFailure('RUN_NOT_RETRYABLE', '当前执行不允许创建关联重试。');
    }
    await _controlRun(
      _map(jsonDecode(jsonEncode(current))),
      'retry_run',
      'retry',
    );
  });

  Future<void> submit() => _perform((epoch) async {
    final selected = task;
    final current = draft;
    if (selected == null || current == null || pending != null) return;
    if (uploadRecoveryStatus == 'saved_unbound') {
      throw ApiFailure(
        'UNRESOLVED_UPLOAD',
        '文件已保存但尚未绑定原草稿。请先打开原任务核对并恢复绑定，再确认正式提交。',
      );
    }
    if (!selected.actions.contains('submit')) {
      throw ApiFailure('NOT_ALLOWED', '当前任务状态不允许提交，请刷新核对。');
    }
    if (selected.requirementVersion != current['requirement_version']) {
      throw ApiFailure(
        'REQUIREMENT_VERSION_CONFLICT',
        '要求已更新，请重新核对并创建当前要求的草稿。',
      );
    }
    final operation = PendingOperation(
      key: _operationKey(),
      action: 'submit_materials',
      targetId: selected.id,
      path: '/v1/tasks/${selected.id}/submissions',
      body: {
        'draft_id': current['draft_id'],
        'draft_version': current['draft_version'],
        'requirement_version': current['requirement_version'],
        'expected_effective_submission_id':
            current['revision_of_submission_id'],
      },
    );
    await _formal(operation);
    await _loadDetail(selected.id);
    await _loadHome();
  });

  Future<void> reconcile() => _perform((epoch) async {
    final operation = pending;
    final selectedGeneration = _selectedRunGeneration;
    if (operation == null) return;
    final result = await api.request(
      'POST',
      '/v1/operations/lookup',
      body: {
        'action': operation.action,
        'target_id': operation.targetId,
        'idempotency_key': operation.key,
      },
    );
    if (result['status'] == 'succeeded') {
      final reference = _map(result['receipt']);
      if (operation.action == 'submit_materials') {
        if (reference['kind'] != 'submission') {
          throw ApiFailure('RECEIPT_MISMATCH', '回执类型不匹配，请保留原操作继续核对。');
        }
        final rows = await _allPages(
          '/v1/tasks/${operation.targetId}/my-submissions',
        );
        final found = rows
            .where((value) => value['submission_id'] == reference['id'])
            .toList();
        if (found.length != 1) {
          throw ApiFailure('RECEIPT_NOT_VISIBLE', '原操作已记录，但回执尚未取回，请稍后继续核对。');
        }
        receipt = found.single;
      } else if (operation.action == 'start_check') {
        if (reference['kind'] != 'run') {
          throw ApiFailure('RECEIPT_MISMATCH', '执行回执类型不匹配，请继续核对。');
        }
        final restoredRun = await api.request(
          'GET',
          '/v1/runs/${reference['id']}',
        );
        await _saveRun(operation.targetId, restoredRun);
      } else if (operation.action == 'upload_file') {
        if (reference['kind'] != 'file') {
          throw ApiFailure('RECEIPT_MISMATCH', '文件回执类型不匹配，请保留原上传继续核对。');
        }
        final file = await api.request(
          'GET',
          '/v1/files/${Uri.encodeComponent(reference['id'] as String)}',
        );
        await _saveUploadedFile(operation, file);
      } else if (_isRunControl(operation.action)) {
        if (reference['kind'] != 'run') {
          throw ApiFailure('RECEIPT_MISMATCH', '原执行操作回执类型不匹配。');
        }
        final value = await api.request(
          'GET',
          '/v1/runs/${Uri.encodeComponent(reference['id'] as String)}',
        );
        await _applyRunControl(
          operation,
          value,
          expectedGeneration: selectedGeneration,
        );
      } else if (operation.action == 'read_notification') {
        if (reference['kind'] != 'notification' ||
            reference['id'] != operation.targetId) {
          throw ApiFailure('RECEIPT_MISMATCH', '原消息已读回执不匹配。');
        }
        await api.request(
          'GET',
          '/v1/notifications/${Uri.encodeComponent(operation.targetId)}',
        );
        await _loadNotifications(epoch);
      } else if (operation.action != 'confirm_notice') {
        throw ApiFailure('UNSUPPORTED_OPERATION', '当前版本无法自动恢复此操作，请保留记录。');
      }
      await _clearPending();
      await _loadHome();
      if (task?.id == operation.targetId) await _loadDetail(operation.targetId);
      if (operation.action == 'start_check' &&
          draft?['draft_id'] == operation.targetId &&
          task != null) {
        await _loadDetail(task!.id);
      }
      notice = operation.action == 'upload_file'
          ? '已找回原文件，请核对后将文件加入原草稿；尚未正式提交。'
          : '已查询到原操作结果，没有再次发起提交。';
    } else if (result['status'] == 'failed' &&
        result['outcome'] == 'no_effect') {
      await _clearPending();
      if (operation.action == 'upload_file') uploadRecoveryStatus = 'failed';
      notice = '服务端确认原操作未产生业务效果，请核对问题后再操作。';
    } else {
      canRetryOriginal =
          result['status'] != 'processing' &&
          (operation.action != 'upload_file' || operation.canReplayUpload);
      notice = '结果仍待核对，保留原操作键；没有重新提交。';
    }
  });

  Future<void> retryPending() => _perform((epoch) async {
    final operation = pending;
    if (operation == null || !canRetryOriginal) return;
    if (![
          'submit_materials',
          'confirm_notice',
          'start_check',
          'upload_file',
          'cancel_run',
          'retry_run',
          'supply_run_input',
          'read_notification',
        ].contains(operation.action) ||
        (operation.action == 'upload_file' && !operation.canReplayUpload)) {
      throw ApiFailure('UNSUPPORTED_OPERATION', '此类操作尚不支持原请求重试。');
    }
    await _sendOriginal(
      operation,
    ); // Same durable key, target, and exact parameter snapshot.
    await _loadHome();
    final selected = task?.id;
    if (selected != null) await _loadDetail(selected);
  });

  Future<void> setScenario(String scenario) => _perform((epoch) async {
    await api.request(
      'POST',
      '/__demo/scenario',
      control: true,
      body: {'scenario': scenario, if (task != null) 'task_id': task!.id},
    );
    if (task != null) await _loadDetail(task!.id);
    await _loadHome();
    notice = '演示场景已设置，仅影响本机虚拟数据。';
  });

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _selectedRunPoll?.cancel();
    api.close();
    super.dispose();
  }
}
