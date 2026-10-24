import 'dart:io';
import 'dart:convert';
import 'dart:async';
import 'package:http/http.dart' as http;
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:flutter_test/flutter_test.dart';
import 'upload_recovery_test.dart' show RecoveryServer, taskId, pdf;

class _DelayedControl extends http.BaseClient {
  final delegate = http.Client();
  final reached = Completer<void>(), release = Completer<void>();
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await delegate.send(request);
    if (request.url.path.endsWith('/cancel')) {
      reached.complete();
      await release.future;
    }
    return response;
  }

  @override
  void close() => delegate.close();
}

class _DelayedConflict extends http.BaseClient {
  final delegate = http.Client();
  bool armed = false;
  final reached = Completer<void>(), release = Completer<void>();
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (armed && request.url.path.endsWith('/cancel')) {
      return http.StreamedResponse(
        Stream.value(
          utf8.encode(
            jsonEncode({
              'error': {
                'code': 'RESOURCE_VERSION_CONFLICT',
                'message': '执行版本已改变',
                'retryable': false,
                'details': {},
              },
              'meta': {'mode': 'demo', 'request_id': 'req_conflict_test'},
            }),
          ),
        ),
        409,
      );
    }
    final response = await delegate.send(request);
    if (armed &&
        request.method == 'GET' &&
        request.url.path.contains('/v1/runs/')) {
      reached.complete();
      await release.future;
    }
    return response;
  }

  @override
  void close() => delegate.close();
}

void main() {
  late RecoveryServer server;
  late AppController c;
  late MemoryJournal journal;
  setUp(() async {
    final root = Directory('../.local').absolute;
    await root.create(recursive: true);
    server = RecoveryServer(await root.createTemp('run-controls-'));
    await server.start();
    journal = MemoryJournal();
    c = AppController(
      api: ApiClient(origin: server.origin),
      journal: journal,
    );
    await c.login('a');
    await c.openTask(taskId);
    await c.confirm();
    await c.createDraft();
    await c.upload('run.pdf', pdf);
    expect(c.error, isNull);
  });
  tearDown(() async {
    c.dispose();
    await server.stop();
  });
  Future<void> terminal(String id) async {
    for (var i = 0; i < 50; i++) {
      await c.openRun(id);
      if ([
        'succeeded',
        'failed',
        'cancelled',
      ].contains(c.selectedRun?['status'])) {
        return;
      }
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    fail('Run did not finish: ${c.selectedRun} ${c.error}');
  }

  test(
    'waiting input validates fields, lost reply restores original accepted Run and same key',
    () async {
      await c.setScenario('waiting_input');
      await c.startCheck();
      expect(c.error, isNull);
      final id = c.run!['run_id'] as String;
      await c.openRun(id);
      expect(c.selectedRun!['status'], 'waiting_input');
      await c.supplyRunInputs([]);
      expect(c.error, isNotNull);
      final before = await server.state();
      await c.supplyRunInputs([
        {'name': 'not_requested', 'value': 'x'},
      ]);
      expect(c.error, isNotNull);
      expect((await server.state())['operations'], before['operations']);
      await c.setScenario('drop_next_run_response');
      await c.supplyRunInputs([
        {'name': 'explanation', 'value': '已核对原始材料'},
      ]);
      expect(c.pending!.action, 'supply_run_input');
      final key = c.pending!.key;
      final body = c.pending!.body;
      c.dispose();
      c = AppController(
        api: ApiClient(origin: server.origin),
        journal: journal,
      );
      await c.initialize();
      expect(c.pending!.key, key);
      expect(c.pending!.body, body);
      await c.reconcile();
      expect(c.error, isNull);
      expect(c.pending, isNull);
      expect(c.selectedRun!['run_id'], id);
      await terminal(id);
      expect(c.selectedRun!['status'], 'succeeded');
      await c.loadRuns();
      expect(c.runs.map((r) => r['run_id']), contains(id));
      expect(c.receipt, isNull);
    },
  );

  test(
    'failed run retries into a related new Run, and another account cannot inspect it',
    () async {
      await c.setScenario('ai_failure');
      await c.startCheck();
      final original = c.run!['run_id'] as String;
      await terminal(original);
      expect(c.selectedRun!['status'], 'failed');
      await c.api.request(
        'POST',
        '/__demo/scenario',
        control: true,
        body: {'scenario': 'ai_failure', 'enabled': false},
      );
      await c.retryRun();
      expect(c.error, isNull);
      final retried = c.selectedRun!['run_id'] as String;
      expect(retried, isNot(original));
      expect(c.selectedRun!['retry_of'], original);
      await terminal(retried);
      expect(c.selectedRun!['status'], 'succeeded');
      await c.retryRun();
      expect(c.error, isNotNull);
      await c.login('b');
      expect(c.selectedRun, isNull);
      expect(c.runs, isEmpty);
      await c.openRun(retried);
      expect(c.selectedRun, isNull);
      expect(c.error, isNotNull);
      await c.login('a');
      await c.loadRuns();
      expect(
        c.runs.map((r) => r['run_id']).toSet(),
        containsAll([original, retried]),
      );
    },
  );

  test(
    'cancel response loss retains the original control operation and accepts the final server state',
    () async {
      await c.setScenario('waiting_input');
      await c.startCheck();
      final id = c.run!['run_id'] as String;
      await c.openRun(id);
      await c.setScenario('drop_next_run_response');
      await c.cancelRun();
      expect(c.pending!.action, 'cancel_run');
      expect(c.pending!.targetId, id);
      await c.reconcile();
      expect(c.pending, isNull);
      expect(c.error, isNull);
      await terminal(id);
      expect(c.selectedRun!['status'], 'cancelled');
      await c.cancelRun();
      expect(c.pending, isNull);
      expect(c.task!.state['submission_status'], 'none');
    },
  );

  test(
    'automatic polling refreshes the same task check and stops at the terminal state',
    () async {
      await c.setScenario('waiting_input');
      await c.startCheck();
      final id = c.run!['run_id'] as String;
      await c.openRun(id);
      await c.supplyRunInputs([
        {'name': 'explanation', 'value': '原材料说明'},
      ]);
      await Future<void>.delayed(const Duration(milliseconds: 1400));
      expect(c.error, isNull);
      expect(c.selectedRun!['status'], 'succeeded');
      expect(c.run!['run_id'], id);
      expect(c.run!['status'], 'succeeded');
      expect(c.check!['check_id'], c.run!['check_id']);
      final terminalVersion = c.selectedRun!['resource_version'];
      await Future<void>.delayed(const Duration(milliseconds: 1100));
      expect(c.selectedRun!['resource_version'], terminalVersion);
    },
  );

  test(
    'version conflict refresh does not reopen a run detail closed during the read',
    () async {
      await c.setScenario('waiting_input');
      await c.startCheck();
      final id = c.run!['run_id'] as String;
      c.dispose();
      final transport = _DelayedConflict();
      c = AppController(
        api: ApiClient(origin: server.origin, client: transport),
        journal: journal,
      );
      await c.initialize();
      await c.openTask(taskId);
      await c.openRun(id);
      transport.armed = true;
      final operation = c.cancelRun();
      await transport.reached.future;
      c.closeRun();
      transport.release.complete();
      await operation;
      expect(c.pending, isNull);
      expect(c.selectedRun, isNull);
      expect(c.error, isNotNull);
    },
  );

  test(
    'closing run detail while a control reply is delayed does not reopen the old detail',
    () async {
      await c.setScenario('waiting_input');
      await c.startCheck();
      final id = c.run!['run_id'] as String;
      c.dispose();
      final transport = _DelayedControl();
      c = AppController(
        api: ApiClient(origin: server.origin, client: transport),
        journal: journal,
      );
      await c.initialize();
      await c.openTask(taskId);
      await c.openRun(id);
      final operation = c.cancelRun();
      await transport.reached.future;
      c.closeRun();
      transport.release.complete();
      await operation;
      expect(c.pending, isNull);
      expect(c.selectedRun, isNull);
      expect(c.error, isNull);
      await c.loadRuns();
      expect(c.runs.any((run) => run['run_id'] == id), isTrue);
    },
  );
}
