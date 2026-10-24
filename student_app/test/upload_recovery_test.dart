import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/domain/models.dart'
    show uploadDigest, PendingOperation;
import 'package:flutter_test/flutter_test.dart';
import 'package:sembast/sembast_io.dart';

const taskId = 'task_demo_pending';
final pdf = Uint8List.fromList(
  utf8.encode('%PDF-1.4\nsynthetic recovery original bytes\n%%EOF'),
);

class RecoveryServer {
  RecoveryServer(this.directory);
  final Directory directory;
  Process? process;
  StreamSubscription<String>? output;
  StreamSubscription<String>? errors;
  String origin = '';
  Future<void> start({String? fixedPort}) async {
    final child = await Process.start(
      'node',
      ['../mock-server/server.mjs'],
      environment: {
        'PORT': fixedPort ?? '0',
        'DEMO_DATA_DIR': directory.path,
        'DEMO_CLOCK': '2026-10-16T04:00:00Z',
      },
    );
    process = child;
    final ready = Completer<String>();
    final diagnostic = StringBuffer();
    output = child.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          diagnostic.writeln(line);
          final match = RegExp(r'http://127\.0\.0\.1:\d+').firstMatch(line);
          if (match != null && !ready.isCompleted) {
            ready.complete(match.group(0)!);
          }
        });
    errors = child.stderr.transform(utf8.decoder).listen(diagnostic.write);
    unawaited(
      child.exitCode.then((code) {
        if (!ready.isCompleted) {
          ready.completeError(StateError('server exit $code: $diagnostic'));
        }
      }),
    );
    origin = await ready.future.timeout(const Duration(seconds: 20));
  }

  Future<void> stop() async {
    process?.kill();
    await process?.exitCode.timeout(const Duration(seconds: 5));
    await output?.cancel();
    await errors?.cancel();
    process = null;
  }

  Future<Map<String, dynamic>> state() async => Map<String, dynamic>.from(
    jsonDecode(await File('${directory.path}/state.json').readAsString())
        as Map,
  );
}

class _NoPendingJournal extends MemoryJournal {
  @override
  Future<void> write(String key, Map<String, dynamic> value) async {
    if (key.endsWith(':pending')) {
      throw StateError('test durable commit rejected');
    }
    return super.write(key, value);
  }
}

void main() {
  test(
    'upload hash agrees with independent SHA256 padding boundary vectors',
    () {
      const expected = {
        0: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        3: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
        56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
        64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
        65: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
      };
      for (final entry in expected.entries) {
        final value = entry.key == 3
            ? utf8.encode('abc')
            : List<int>.filled(entry.key, 97);
        expect(
          uploadDigest(Uint8List.fromList(value)),
          entry.value,
          reason: '${entry.key} bytes',
        );
      }
    },
  );

  late RecoveryServer server;
  Database? database;
  AppController? controller;
  late Directory local;
  setUp(() async {
    final root = Directory('../.local').absolute;
    await root.create(recursive: true);
    local = await root.createTemp('upload-recovery-');
    server = RecoveryServer(Directory('${local.path}/server'));
    await server.start();
  });
  tearDown(() async {
    controller?.dispose();
    controller = null;
    await database?.close();
    database = null;
    await server.stop();
  });
  AppController create(Journal journal) => AppController(
    api: ApiClient(origin: server.origin, timeout: const Duration(seconds: 3)),
    journal: journal,
  );
  Future<void> prepare(Journal journal) async {
    controller = create(journal);
    await controller!.login('a');
    await controller!.openTask(taskId);
    await controller!.confirm();
    await controller!.createDraft();
    expect(controller!.error, isNull);
  }

  test(
    'lost upload response survives disk journal and service restart with the same original file',
    () async {
      final path = '${local.path}/journal.db';
      database = await databaseFactoryIo.openDatabase(path);
      await prepare(DurableJournal(database!));
      final draftId = controller!.draft!['draft_id'];
      await controller!.setScenario('drop_next_upload_response');
      await controller!.upload('original.pdf', pdf);
      expect(controller!.pending?.action, 'upload_file');
      expect(controller!.pending?.targetId, taskId);
      expect(controller!.receipt, isNull);
      final originalKey = controller!.pending!.key;
      final before = await server.state();
      final stored = (before['operations'] as Map).values
          .cast<Map>()
          .singleWhere((row) => row['key'] == originalKey);
      final fileId = (stored['receipt'] as Map)['id'];
      final original = controller!.pending!.toJson();
      final port = Uri.parse(server.origin).port.toString();
      controller!.dispose();
      controller = null;
      await database!.close();
      database = null;
      await server.stop();
      await server.start(fixedPort: port);
      database = await databaseFactoryIo.openDatabase(path);
      controller = create(DurableJournal(database!));
      await controller!.initialize();
      expect(controller!.pending!.toJson(), original);
      await controller!.reconcile();
      expect(controller!.error, isNull);
      expect(controller!.pending, isNull);
      expect(controller!.savedUpload?['file_id'], fileId);
      expect(controller!.savedUploadDraftId, draftId);
      expect(controller!.uploadRecoveryStatus, 'saved_unbound');
      await controller!.openTask(taskId);
      await controller!.bindSavedUpload();
      expect(controller!.error, isNull);
      expect(controller!.files.single['file_id'], fileId);
      expect(controller!.task!.state['submission_status'], 'none');
      expect(await controller!.downloadFile(fileId as String), pdf);
      final after = await server.state();
      expect((after['files'] as Map).length, (before['files'] as Map).length);
      expect(
        (after['operations'] as Map).values.where(
          (row) => (row as Map)['key'] == originalKey,
        ),
        hasLength(1),
      );
    },
    timeout: const Timeout(Duration(seconds: 45)),
  );

  test(
    'saved upload survives a stale draft conflict and only binds on an explicit recovery action',
    () async {
      await prepare(MemoryJournal());
      final current = controller!.draft!;
      final external = ApiClient(origin: server.origin)..useDemoAccount('a');
      addTearDown(external.close);
      await external.request(
        'PATCH',
        '/v1/submission-drafts/${current['draft_id']}',
        body: {
          'draft_version': current['draft_version'],
          'requirement_version': current['requirement_version'],
          'file_ids': current['file_ids'],
          'text': 'another device saved this explanation',
        },
      );
      await controller!.upload('conflict.pdf', pdf);
      expect(controller!.savedUpload, isNotNull);
      expect(controller!.uploadRecoveryStatus, 'saved_unbound');
      final fileId = controller!.savedUpload!['file_id'];
      final before = await server.state();
      await controller!.bindSavedUpload();
      expect(controller!.error, isNull);
      expect(controller!.files.single['file_id'], fileId);
      expect(
        controller!.draft!['text'],
        'another device saved this explanation',
      );
      expect((await server.state())['files'], before['files']);
      expect(controller!.receipt, isNull);
    },
  );

  test(
    'saved unbound second file prevents formal submission of the older ready draft',
    () async {
      await prepare(MemoryJournal());
      await controller!.upload('first-ready.pdf', pdf);
      expect(controller!.error, isNull);
      expect(controller!.files, hasLength(1));
      final current = controller!.draft!;
      final external = ApiClient(origin: server.origin)..useDemoAccount('a');
      addTearDown(external.close);
      await external.request('PATCH', '/v1/submission-drafts/${current['draft_id']}', body: {
        'draft_version': current['draft_version'],
        'requirement_version': current['requirement_version'],
        'file_ids': current['file_ids'], 'text': 'another device saved this draft',
      });
      await controller!.upload('second-unbound.pdf', pdf);
      expect(controller!.savedUpload, isNotNull);
      expect(controller!.uploadRecoveryStatus, 'saved_unbound');
      expect(controller!.pending, isNull);
      await controller!.refresh();
      expect(controller!.uploadRecoveryStatus, 'saved_unbound');
      expect(controller!.task!.actions, contains('submit'));
      final before = await server.state();
      await controller!.submit();
      final after = await server.state();
      expect(after['operations'], before['operations'], reason: 'unbound file must prevent a formal POST/key from being stored');
      expect(after['submissions'], before['submissions']);
      expect(controller!.pending, isNull);
      expect(controller!.receipt, isNull);
      expect(controller!.uploadRecoveryStatus, 'saved_unbound');
    },
  );

  test(
    'PATCH saved then lost response is reconciled by reading draft without a duplicate patch',
    () async {
      await prepare(MemoryJournal());
      await controller!.setScenario('drop_next_patch_response');
      await controller!.upload('patch-lost.pdf', pdf);
      await controller!.refresh();
      if (controller!.savedUpload != null) await controller!.bindSavedUpload();
      expect(controller!.error, isNull);
      expect(controller!.files, hasLength(1));
      expect(controller!.draft!['draft_version'], 2);
      expect(controller!.task!.state['submission_status'], 'none');
    },
  );

  test(
    'failed durable commit prevents upload HTTP and file creation',
    () async {
      await prepare(_NoPendingJournal());
      final before = await server.state();
      await controller!.upload('no-commit.pdf', pdf);
      expect(controller!.error, isNotNull);
      expect((await server.state())['files'], before['files']);
    },
  );

  test(
    'saved unbound file is private and returns only with the original account',
    () async {
      await prepare(MemoryJournal());
      await controller!.setScenario('drop_next_upload_response');
      await controller!.upload('private.pdf', pdf);
      final key = controller!.pending!.key;
      await controller!.login('b');
      expect(controller!.pending, isNull);
      expect(controller!.savedUpload, isNull);
      await controller!.login('a');
      expect(controller!.pending!.key, key);
      await controller!.reconcile();
      final file = controller!.savedUpload!;
      await controller!.login('b');
      expect(controller!.savedUpload, isNull);
      await expectLater(
        controller!.downloadFile(file['file_id'] as String),
        completion(isNull),
      );
      await controller!.login('a');
      expect(controller!.savedUpload!['file_id'], file['file_id']);
      expect(controller!.savedUploadDraftId, isNotNull);
      await controller!.openTask(taskId);
      await controller!.bindSavedUpload();
      expect(controller!.error, isNull);
      expect(controller!.draft?['draft_id'], controller!.savedUploadDraftId);
      expect(controller!.files.single['file_id'], file['file_id']);
      expect(controller!.task!.state['submission_status'], 'none');
    },
  );

  test(
    'legacy upload target and parameters stay unchanged and cannot be replayed as a new protocol',
    () async {
      final journal = MemoryJournal();
      final original = {
        'key': 'legacy_unknown_upload_key',
        'action': 'upload_file',
        'target_id': 'files',
        'path': '/v1/files',
        'body': {'purpose': 'submission_material', 'task_id': taskId},
      };
      final scope = 'demo:${server.origin}:a';
      await journal.write('$scope:pending', {'operation': original});
      controller = create(journal);
      await controller!.login('a');
      final before = await server.state();
      await controller!.reconcile();
      expect(controller!.canRetryOriginal, isFalse);
      expect(controller!.pending!.targetId, 'files');
      await controller!.retryPending();
      expect((await server.state())['files'], before['files']);
      final stored = PendingOperation.fromJson(
        Map<String, dynamic>.from(
          (await journal.read('$scope:pending'))!['operation'] as Map,
        ),
      );
      expect(stored.body, original['body']);
      expect(stored.key, original['key']);
      expect(stored.targetId, 'files');
      expect(stored.contractVersion, 'legacy_unknown');
    },
  );
}
