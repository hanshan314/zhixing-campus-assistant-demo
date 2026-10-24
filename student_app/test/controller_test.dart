import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/domain/models.dart' show uploadDigest;

Json clone(Json value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);

class World {
  World() {
    final fixtures =
        jsonDecode(
              File('../contracts/upstream/examples.json').readAsStringSync(),
            )
            as Map;
    entities = Map<String, dynamic>.from(fixtures['entities'] as Map);
    task = clone(Map<String, dynamic>.from(entities['task'] as Map));
  }
  late Json entities;
  late Json task;
  Json? draft;
  Json? submission;
  Json? run;
  int checkCalls = 0;
  Json? submittedBody;
  String? submittedKey;
  int submitCalls = 0;
  bool dropSubmissionResponse = false;
  bool loseBeforeSave = false;
  bool unauthorized = false;
  String lookupStatus = 'succeeded';
  String lookupOutcome = 'effect_recorded';
  final calls = <String>[];
  String get id => task['task_id'] as String;

  http.Response reply(Json data, [int status = 200]) => http.Response(
    jsonEncode({
      'data': data,
      'meta': {
        'mode': 'demo',
        'request_id': 'req_demo_test',
        'server_time': '2026-10-15T20:00:00+08:00',
      },
    }),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  Json page(List<Json> values) => {
    'items': values,
    'has_more': false,
    'next_cursor': null,
    'as_of': '2026-10-15T20:00:00+08:00',
  };

  Future<http.Response> handle(http.Request request) async {
    final path = request.url.path;
    calls.add('${request.method} $path');
    if (unauthorized) {
      return http.Response(
        jsonEncode({
          'error': {'code': 'AUTH_REQUIRED', 'message': 'expired'},
          'meta': {'mode': 'demo', 'request_id': 'req_expired'},
        }),
        401,
      );
    }
    if (path == '/v1/me') {
      return reply(Map<String, dynamic>.from(entities['identity'] as Map));
    }
    if (path == '/v1/capabilities') {
      return reply({
        'upload': {'max_bytes': 10485760},
      });
    }
    if (path == '/v1/me/tasks') return reply(page([task]));
    if (path == '/v1/tasks/$id') return reply(task);
    if (path.startsWith('/v1/sources/')) {
      return reply(Map<String, dynamic>.from(entities['source'] as Map));
    }
    if (path.endsWith('/my-submissions')) {
      return reply(page(submission == null ? [] : [submission!]));
    }
    if (path == '/v1/files' && request.method == 'POST') {
      // MockClient receives encoded multipart. Return a receipt for those actual
      // bytes, rather than the unrelated fixed contract-example content hash.
      final body = request.bodyBytes;
      final content = latin1.decode(body);
      final start = content.indexOf('%PDF-');
      final boundary = RegExp(
        r'boundary=([^;]+)',
      ).firstMatch(request.headers['content-type'] ?? '')?.group(1);
      final end = start < 0 || boundary == null
          ? -1
          : content.indexOf('\r\n--$boundary', start);
      if (start >= 0 && end >= start) {
        (entities['file'] as Map)['content_hash'] = uploadDigest(
          Uint8List.fromList(body.sublist(start, end)),
        );
        (entities['file'] as Map)['size'] = end - start;
      }
      return reply(Map<String, dynamic>.from(entities['file'] as Map), 201);
    }
    if (path.startsWith('/v1/files/')) {
      return reply(Map<String, dynamic>.from(entities['file'] as Map));
    }
    if (path.startsWith('/v1/runs/')) return reply(run!);
    if (path.endsWith('/checks')) {
      checkCalls++;
      run = clone(Map<String, dynamic>.from(entities['run'] as Map));
      return reply(run!, 202);
    }
    if (path.endsWith('/submission-drafts')) {
      final input = jsonDecode(request.body) as Map;
      draft = clone(Map<String, dynamic>.from(entities['draft'] as Map));
      draft!.addAll({
        'file_ids': input['file_ids'],
        'text': input['text'],
        'revision_of_submission_id': input['revision_of_submission_id'],
        'current_check_id': null,
        'draft_version': 1,
      });
      return reply(draft!, 201);
    }
    if (path.startsWith('/v1/submission-drafts/')) {
      if (request.method == 'PATCH') {
        final input = Map<String, dynamic>.from(
          jsonDecode(request.body) as Map,
        );
        draft!.addAll(input);
        draft!['draft_version'] = (input['draft_version'] as int) + 1;
        draft!['current_check_id'] = null;
      }
      return reply(draft!);
    }
    if (path.endsWith('/submissions') && request.method == 'POST') {
      submitCalls++;
      submittedKey =
          request.headers['Idempotency-Key'] ??
          request.headers['idempotency-key'];
      submittedBody = Map<String, dynamic>.from(
        jsonDecode(request.body) as Map,
      );
      if (loseBeforeSave) {
        throw http.ClientException('never reached durable service');
      }
      submission = clone(
        Map<String, dynamic>.from(entities['submission'] as Map),
      );
      submission!['draft_id'] = draft!['draft_id'];
      submission!['draft_version'] = draft!['draft_version'];
      final state = Map<String, dynamic>.from(task['student_state'] as Map);
      state.addAll({
        'submission_status': 'submitted',
        'effective_submission_id': submission!['submission_id'],
        'review_status': 'pending',
        'display_status': 'submitted_pending_review',
      });
      task['student_state'] = state;
      if (dropSubmissionResponse) {
        throw http.ClientException('lost after persistence');
      }
      return reply(submission!, 201);
    }
    if (path == '/v1/operations/lookup') {
      final input = jsonDecode(request.body) as Map;
      expect(input.keys.toSet(), {'action', 'target_id', 'idempotency_key'});
      expect(input['action'], 'submit_materials');
      expect(input['idempotency_key'], submittedKey);
      return reply({
        'status': lookupStatus,
        'outcome': lookupOutcome,
        'receipt': lookupStatus == 'succeeded'
            ? {
                'kind': 'submission',
                'id': submission!['submission_id'],
                'result_path': '/v1/tasks/$id/my-submissions',
              }
            : null,
        'retry_after_seconds': lookupStatus == 'succeeded' ? null : 2,
        'next_action': lookupStatus == 'succeeded'
            ? 'read_receipt'
            : 'lookup_same_operation',
        if (lookupStatus == 'failed')
          'error': {
            'code': 'SERVICE_UNAVAILABLE',
            'message': 'uncertain',
            'retryable': true,
            'details': {},
          },
      });
    }
    throw StateError('Unexpected test request: ${request.method} $path');
  }

  AppController controller(Journal journal) => AppController(
    api: ApiClient(
      origin: 'http://127.0.0.1:18765',
      client: MockClient(handle),
    ),
    journal: journal,
  );
}

class RefusingJournal extends MemoryJournal {
  @override
  Future<void> write(String key, Json value) async {
    if (key.endsWith(':pending') &&
        (value['operation'] as Map?)?['action'] == 'submit_materials') {
      throw StateError('disk full');
    }
    return super.write(key, value);
  }
}

class DelayedReadJournal extends MemoryJournal {
  final gate = Completer<void>();
  int reads = 0;
  @override
  Future<Json?> read(String key) async {
    if (key == 'selected_demo_account' && reads++ == 0) await gate.future;
    return super.read(key);
  }
}

Future<void> prepare(World world, AppController controller) async {
  await controller.login('a');
  await controller.openTask(world.id);
  await controller.createDraft();
  await controller.upload(
    'demo.pdf',
    Uint8List.fromList(utf8.encode('%PDF-1.4\nsynthetic')),
  );
  expect(controller.error, isNull);
}

void main() {
  test('reauthentication preserves an unresolved original operation', () async {
    final world = World();
    final journal = MemoryJournal();
    final controller = world.controller(journal);
    addTearDown(controller.dispose);
    await prepare(world, controller);
    world.unauthorized = true;
    await controller.submit();
    expect(controller.identity, isNull);
    expect(world.submitCalls, 0);
    final record = journal.records.entries
        .singleWhere((row) => row.key.endsWith(':pending'))
        .value;
    final originalKey = (record['operation'] as Map)['key'];
    world.unauthorized = false;
    await controller.login('a');
    expect(controller.pending!.key, originalKey);
    expect(controller.canRetryOriginal, isFalse);
  });
  test(
    '401 immediately notifies listeners after locking private views',
    () async {
      final world = World();
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      var sawLockedView = false;
      controller.addListener(() {
        if (controller.identity == null && controller.task == null) {
          sawLockedView = true;
        }
      });
      world.unauthorized = true;
      await controller.refresh();
      expect(sawLockedView, isTrue);
      expect(controller.identity, isNull);
      expect(controller.busy, isFalse);
    },
  );

  test(
    'after unknown lookup the explicit retry uses the same durable intent',
    () async {
      final world = World()..loseBeforeSave = true;
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      await controller.submit();
      final original = controller.pending!;
      expect(world.submission, isNull);
      expect(controller.canRetryOriginal, isFalse);
      world.lookupStatus = 'not_found';
      world.lookupOutcome = 'unknown';
      await controller.reconcile();
      expect(controller.canRetryOriginal, isTrue);
      world.loseBeforeSave = false;
      await controller.retryPending();
      expect(controller.pending, isNull);
      expect(controller.receipt, isNotNull);
      expect(world.submittedKey, original.key);
      expect(world.submittedBody, original.body);
      expect(world.submitCalls, 2);
    },
  );

  test(
    'a slow previous login cannot replace the latest selected account',
    () async {
      final world = World();
      final journal = DelayedReadJournal();
      final controller = world.controller(journal);
      addTearDown(controller.dispose);
      final oldLogin = controller.login('a');
      await controller.login('b');
      journal.gate.complete();
      await oldLogin;
      expect(controller.account, 'b');
      expect(journal.records['selected_demo_account']!['account'], 'b');
      expect(controller.busy, isFalse);
    },
  );

  test(
    'accepted Run is restored after restart without launching another check',
    () async {
      final world = World();
      final journal = MemoryJournal();
      final first = world.controller(journal);
      await prepare(world, first);
      await first.startCheck();
      expect(first.error, isNull);
      final runId = first.run!['run_id'];
      first.dispose();
      final second = world.controller(journal);
      addTearDown(second.dispose);
      await second.initialize();
      await second.openTask(world.id);
      expect(second.run!['run_id'], runId);
      expect(world.checkCalls, 1);
    },
  );

  test(
    'revision retains original effective submission compare-and-swap value',
    () async {
      final world = World();
      (world.task['student_state'] as Map)['effective_submission_id'] =
          'sub_before_edit';
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      (world.task['student_state'] as Map)['effective_submission_id'] =
          'sub_other_device';
      await controller.refresh();
      await controller.submit();
      expect(
        world.submittedBody!['expected_effective_submission_id'],
        'sub_before_edit',
      );
    },
  );

  test(
    'upload remains a draft and does not change formal submission state',
    () async {
      final world = World();
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      expect(controller.files, hasLength(1));
      expect(controller.task!.state['submission_status'], 'none');
      expect(world.submitCalls, 0);
    },
  );

  test('durable journal failure prevents sending a formal request', () async {
    final world = World();
    final controller = world.controller(RefusingJournal());
    addTearDown(controller.dispose);
    await prepare(world, controller);
    await controller.submit();
    expect(world.submitCalls, 0);
    expect(controller.error, contains('disk full'));
  });

  test(
    'lost response survives client restart and resolves without resubmission',
    () async {
      final world = World()..dropSubmissionResponse = true;
      final journal = MemoryJournal();
      final first = world.controller(journal);
      await prepare(world, first);
      await first.submit();
      expect(first.pending, isNotNull);
      expect(world.submittedBody!.keys.toSet(), {
        'draft_id',
        'draft_version',
        'requirement_version',
        'expected_effective_submission_id',
      });
      final originalKey = first.pending!.key;
      first.dispose();
      final restored = world.controller(journal);
      addTearDown(restored.dispose);
      await restored.initialize();
      expect(restored.pending!.key, originalKey);
      expect(world.submitCalls, 1);
      await restored.reconcile();
      expect(restored.pending, isNull);
      expect(
        restored.receipt!['submission_id'],
        world.submission!['submission_id'],
      );
      expect(world.submitCalls, 1);
    },
  );

  test(
    'not_found and failed with unknown outcome never clear original intent',
    () async {
      final world = World()..dropSubmissionResponse = true;
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      await controller.submit();
      final key = controller.pending!.key;
      world.lookupStatus = 'not_found';
      world.lookupOutcome = 'unknown';
      await controller.reconcile();
      expect(controller.pending!.key, key);
      world.lookupStatus = 'failed';
      await controller.reconcile();
      expect(controller.pending!.key, key);
      expect(world.submitCalls, 1);
    },
  );

  test(
    'account switch isolates original operation and removes private draft cache',
    () async {
      final world = World()..dropSubmissionResponse = true;
      final journal = MemoryJournal();
      final controller = world.controller(journal);
      addTearDown(controller.dispose);
      await prepare(world, controller);
      await controller.submit();
      expect(controller.pending, isNotNull);
      await controller.login('b');
      expect(controller.task, isNull);
      expect(controller.pending, isNull);
      expect(
        journal.records.keys.where(
          (key) => key.contains(':a:') && !key.endsWith(':pending'),
        ),
        isEmpty,
      );
      await controller.login('a');
      expect(controller.pending, isNotNull);
      await controller.reconcile();
      expect(controller.pending, isNull);
      expect(world.submitCalls, 1);
    },
  );
}
