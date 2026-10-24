import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:flutter_test/flutter_test.dart';

/// These plain test() cases use real HTTP, real multipart bytes, and a private
/// Node child process. They do not use WidgetTester HTTP overrides or MockClient.
class _HttpService {
  _HttpService(
    this.process,
    this.origin,
    this.stdoutSubscription,
    this.stderrSubscription,
    this.dataDirectory,
  );

  final Process process;
  final String origin;
  final StreamSubscription<String> stdoutSubscription;
  final StreamSubscription<String> stderrSubscription;
  final Directory dataDirectory;
  bool _closed = false;

  static Future<_HttpService> start() async {
    final dataDirectory = Directory(
      '${Directory.current.parent.path}${Platform.pathSeparator}.local'
      '${Platform.pathSeparator}e2e-${DateTime.now().microsecondsSinceEpoch}-$pid',
    );
    await dataDirectory.create(recursive: true);
    final process = await Process.start(
      'node',
      ['../mock-server/server.mjs'],
      environment: {
        'PORT': '0',
        'DEMO_DATA_DIR': dataDirectory.absolute.path,
        'DEMO_CLOCK': '2026-10-15T12:00:00Z',
      },
    );
    final ready = Completer<String>();
    final diagnostics = StringBuffer();
    final stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            diagnostics.writeln(line);
            final address = RegExp(r'http://127\.0\.0\.1:\d+').firstMatch(line);
            if (address != null && !ready.isCompleted) {
              ready.complete(address.group(0)!);
            }
          },
          onError: (Object error, StackTrace stack) {
            if (!ready.isCompleted) ready.completeError(error, stack);
          },
        );
    final stderrSubscription = process.stderr
        .transform(utf8.decoder)
        .listen(diagnostics.write);
    unawaited(
      process.exitCode.then((code) {
        if (!ready.isCompleted) {
          ready.completeError(
            StateError(
              'Private demo service exited before readiness ($code): $diagnostics',
            ),
          );
        }
      }),
    );

    final service = _HttpService(
      process,
      '',
      stdoutSubscription,
      stderrSubscription,
      dataDirectory,
    );
    try {
      final origin = await ready.future.timeout(
        const Duration(seconds: 20),
        onTimeout: () => throw TimeoutException(
          'Private demo service did not start: $diagnostics',
        ),
      );
      return _HttpService(
        process,
        origin,
        stdoutSubscription,
        stderrSubscription,
        dataDirectory,
      );
    } catch (_) {
      await service.close();
      rethrow;
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    // Only terminate the Process instance spawned by this test. Do not kill by
    // executable name or remove the retained per-test evidence directory.
    process.kill(ProcessSignal.sigterm);
    try {
      await process.exitCode.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      await process.exitCode.timeout(const Duration(seconds: 5));
    } finally {
      await stdoutSubscription.cancel();
      await stderrSubscription.cancel();
    }
  }

  AppController controller(MemoryJournal journal) => AppController(
    api: ApiClient(origin: origin, timeout: const Duration(seconds: 5)),
    journal: journal,
    pollInterval: const Duration(milliseconds: 30),
  );
}

Future<Uint8List> _assetPdf() async {
  final bytes = await File('assets/demo-practice.pdf').readAsBytes();
  expect(bytes.length, greaterThan(100));
  expect(utf8.decode(bytes.take(5).toList()), '%PDF-');
  return bytes;
}

void _healthy(AppController controller) {
  expect(controller.error, isNull);
  expect(controller.busy, isFalse);
}

Future<void> _waitForCheck(AppController controller) async {
  final deadline = DateTime.now().add(const Duration(seconds: 10));
  while (DateTime.now().isBefore(deadline)) {
    if (controller.error != null) {
      fail('Real HTTP check failed: ${controller.error}');
    }
    if (controller.run?['status'] == 'succeeded' &&
        controller.check != null &&
        controller.draft?['current_check_id'] ==
            controller.check?['check_id']) {
      return;
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail(
    'Check did not reach a persisted terminal state: '
    'run=${controller.run}, check=${controller.check}, error=${controller.error}',
  );
}

void main() {
  test(
    'real HTTP material flow survives lost submission response and app restart',
    () async {
      final service = await _HttpService.start();
      addTearDown(service.close);
      final journal = MemoryJournal();
      var controller = service.controller(journal);
      addTearDown(() => controller.dispose());
      final pdf = await _assetPdf();

      await controller.login('a');
      _healthy(controller);
      expect(controller.identity!['user_id'], 'user_demo_a');
      expect(controller.capabilities['parse']['available'], isFalse);
      await controller.openTask('task_demo_pending');
      _healthy(controller);
      expect(controller.task!.state['read_status'], 'read');
      expect(controller.task!.state['confirmation_status'], 'pending');
      await controller.confirm();
      _healthy(controller);
      expect(controller.task!.state['confirmation_status'], 'confirmed');
      await controller.createDraft();
      _healthy(controller);
      final draftId = controller.draft!['draft_id'];
      await controller.upload('demo-practice.pdf', pdf);
      _healthy(controller);
      expect(controller.files, hasLength(1));
      expect(controller.files.single['size'], pdf.length);
      expect(controller.task!.state['submission_status'], 'none');
      expect(controller.history, isEmpty);
      expect(controller.draft!['draft_version'], 2);
      await controller.startCheck();
      _healthy(controller);
      await _waitForCheck(controller);
      expect(controller.check!['rule_status'], 'passed');
      expect(controller.check!['submission_draft_id'], draftId);
      expect(controller.check!['ai_suggestions'], isEmpty);

      await controller.setScenario('drop_next_submit_response');
      _healthy(controller);
      await controller.submit();
      expect(controller.pending, isNotNull);
      expect(controller.pending!.action, 'submit_materials');
      expect(controller.receipt, isNull);
      final originalKey = controller.pending!.key;
      final originalBody = Map<String, dynamic>.from(controller.pending!.body);

      controller.dispose();
      controller = service.controller(journal);
      await controller.initialize();
      _healthy(controller);
      expect(controller.pending!.key, originalKey);
      expect(controller.pending!.body, originalBody);
      await controller.openTask('task_demo_pending');
      _healthy(controller);
      expect(controller.history, hasLength(1));
      await controller.reconcile();
      _healthy(controller);
      expect(controller.pending, isNull);
      expect(controller.receipt, isNotNull);
      expect(controller.receipt!['draft_id'], draftId);
      expect(controller.receipt!['submission_version'], 1);
      expect(controller.receipt!['review_status'], 'pending');
      expect(controller.history, hasLength(1));
      expect(
        controller.history.single['submission_id'],
        controller.receipt!['submission_id'],
      );
      expect(
        controller.task!.effectiveSubmission,
        controller.receipt!['submission_id'],
      );
      expect(controller.task!.state['submission_status'], 'submitted');

      final lookup = await controller.api.request(
        'POST',
        '/v1/operations/lookup',
        body: {
          'action': 'submit_materials',
          'target_id': 'task_demo_pending',
          'idempotency_key': originalKey,
        },
      );
      expect(lookup['status'], 'succeeded');
      expect(lookup['receipt']['id'], controller.receipt!['submission_id']);
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );

  test(
    'real HTTP revision preserves history and isolates same-name account state',
    () async {
      final service = await _HttpService.start();
      addTearDown(service.close);
      final journal = MemoryJournal();
      final controller = service.controller(journal);
      addTearDown(controller.dispose);
      final pdf = await _assetPdf();

      await controller.login('a');
      _healthy(controller);
      final aName = controller.identity!['display_name'];
      await controller.openTask('task_demo_revision');
      _healthy(controller);
      expect(controller.task!.status, 'needs_revision');
      expect(controller.history, hasLength(1));
      final oldSubmission = controller.task!.effectiveSubmission!;
      await controller.createDraft();
      _healthy(controller);
      expect(controller.draft!['revision_of_submission_id'], oldSubmission);
      final aDraftId = controller.draft!['draft_id'] as String;
      await controller.upload('demo-practice.pdf', pdf);
      _healthy(controller);
      final aFileId = controller.files.single['file_id'] as String;
      expect(controller.task!.effectiveSubmission, oldSubmission);
      await controller.startCheck();
      _healthy(controller);
      await _waitForCheck(controller);
      final aRunId = controller.run!['run_id'] as String;
      await controller.setScenario('drop_next_submit_response');
      _healthy(controller);
      await controller.submit();
      expect(controller.pending, isNotNull);
      final originalKey = controller.pending!.key;
      expect(
        controller.pending!.body['expected_effective_submission_id'],
        oldSubmission,
      );

      await controller.login('b');
      _healthy(controller);
      expect(controller.identity!['display_name'], aName);
      expect(controller.identity!['user_id'], 'user_demo_b');
      expect(controller.pending, isNull);
      expect(controller.task, isNull);
      expect(controller.draft, isNull);
      expect(controller.files, isEmpty);
      expect(controller.run, isNull);
      expect(controller.receipt, isNull);
      for (final path in [
        '/v1/files/$aFileId',
        '/v1/submission-drafts/$aDraftId',
        '/v1/runs/$aRunId',
      ]) {
        await expectLater(
          controller.api.request('GET', path),
          throwsA(
            isA<ApiFailure>().having((error) => error.status, 'status', 404),
          ),
        );
      }
      await controller.openTask('task_demo_revision');
      _healthy(controller);
      expect(controller.history, hasLength(1));
      expect(controller.history.single['submission_id'], isNot(oldSubmission));
      expect(controller.history.single['submission_version'], 1);
      expect(controller.task!.status, 'needs_revision');
      expect(controller.draft, isNull);
      final bLookup = await controller.api.request(
        'POST',
        '/v1/operations/lookup',
        body: {
          'action': 'submit_materials',
          'target_id': 'task_demo_revision',
          'idempotency_key': originalKey,
        },
      );
      expect(bLookup['status'], 'not_found');
      expect(bLookup['outcome'], 'unknown');

      await controller.login('a');
      _healthy(controller);
      expect(controller.pending!.key, originalKey);
      await controller.reconcile();
      _healthy(controller);
      expect(controller.pending, isNull);
      final revisionReceipt = Map<String, dynamic>.from(controller.receipt!);
      expect(revisionReceipt['submission_version'], 2);
      expect(revisionReceipt['review_status'], 'pending');
      expect(revisionReceipt['submission_id'], isNot(oldSubmission));
      await controller.openTask('task_demo_revision');
      _healthy(controller);
      expect(controller.history, hasLength(2));
      expect(
        controller.history.first['submission_id'],
        revisionReceipt['submission_id'],
      );
      expect(controller.history.last['submission_id'], oldSubmission);
      expect(controller.history.last['review_status'], 'needs_revision');
      expect(
        controller.task!.effectiveSubmission,
        revisionReceipt['submission_id'],
      );
      expect(controller.task!.status, 'submitted_pending_review');
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );
}
