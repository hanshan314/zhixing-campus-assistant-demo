import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'controller_test.dart' show World, clone, prepare;

class RacingWorld extends World {
  final oldResponse = Completer<http.Response>();
  final oldRequested = Completer<void>();
  Json? oldRun;
  @override
  Future<http.Response> handle(http.Request request) async {
    if (request.url.path.endsWith('/checks')) {
      await super.handle(request);
      run!['run_id'] = 'run_test_$checkCalls';
      if (checkCalls == 1) oldRun = clone(run!);
      return reply(run!, 202);
    }
    if (request.url.path == '/v1/runs/run_test_1') {
      if (!oldRequested.isCompleted) oldRequested.complete();
      return oldResponse.future;
    }
    return super.handle(request);
  }
}

void main() {
  test(
    'late response from previous Run cannot replace the current check',
    () async {
      final world = RacingWorld();
      final controller = AppController(
        api: ApiClient(
          origin: 'http://127.0.0.1:18765',
          client: MockClient(world.handle),
        ),
        journal: MemoryJournal(),
        pollInterval: const Duration(milliseconds: 5),
      );
      addTearDown(controller.dispose);
      await prepare(world, controller);
      await controller.startCheck();
      await world.oldRequested.future.timeout(const Duration(seconds: 4));
      await controller.startCheck();
      expect(controller.run!['run_id'], 'run_test_2');
      world.oldResponse.complete(world.reply(world.oldRun!));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(controller.run!['run_id'], 'run_test_2');
      expect(controller.error, isNull);
    },
  );
}
