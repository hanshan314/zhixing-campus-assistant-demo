import 'dart:io';

import 'package:campus_student/data/journal.dart';
import 'package:campus_student/domain/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sembast/sembast_io.dart';

// These tests exercise actual desktop Sembast files through databaseFactoryIo.
// They do not cover Android's application directory or browser IndexedDB.
// Each test retains its unique synthetic database under the ignored .local/.
void main() {
  const scopeA = 'demo:http://127.0.0.1:18765:a';
  const scopeB = 'demo:http://127.0.0.1:18765:b';
  const pendingA = '$scopeA:pending';
  const pendingB = '$scopeB:pending';
  const draftA = '$scopeA:draft:task_demo_persistence';
  const draftB = '$scopeB:draft:task_demo_persistence';

  late File databaseFile;
  Database? database;

  PendingOperation operation(String key) => PendingOperation(
    key: key,
    action: 'submit_materials',
    targetId: 'task_demo_persistence',
    path: '/v1/tasks/task_demo_persistence/submissions',
    body: {
      'draft_id': 'draft_demo_persistence',
      'draft_version': 2,
      'requirement_version': 3,
      'expected_effective_submission_id': 'sub_demo_previous_version',
    },
  );

  Future<DurableJournal> reopen() async {
    await database?.close();
    database = null;
    final opened = await databaseFactoryIo.openDatabase(databaseFile.path);
    database = opened;
    return DurableJournal(opened);
  }

  setUp(() async {
    final root = Directory('../.local').absolute;
    await root.create(recursive: true);
    final directory = await root.createTemp('journal-persistence-');
    databaseFile = File('${directory.path}/demo_journal.db');
  });

  tearDown(() async {
    await database?.close();
    database = null;
    // Intentionally keep the test directory and file for inspection.
  });

  test(
    'file-backed journal restores the original key and parameters after reopen',
    () async {
      final original = operation('demo_original_pending_key_a');
      final first = await reopen();
      await first.write(pendingA, {'operation': original.toJson()});

      final second = await reopen();
      expect(await databaseFile.exists(), isTrue);
      expect(await databaseFile.length(), greaterThan(0));

      final stored = await second.read(pendingA);
      expect(stored, {'operation': original.toJson()});
      final restored = PendingOperation.fromJson(
        Map<String, dynamic>.from(stored!['operation'] as Map),
      );
      expect(restored.key, original.key);
      expect(restored.action, original.action);
      expect(restored.targetId, original.targetId);
      expect(restored.path, original.path);
      expect(restored.body, original.body);
    },
  );

  test(
    'preserving pending operations clears account and private caches on disk',
    () async {
      final originalA = operation('demo_original_pending_key_a');
      final originalB = operation('demo_original_pending_key_b');
      final first = await reopen();
      await first.write(pendingA, {'operation': originalA.toJson()});
      await first.write(pendingB, {'operation': originalB.toJson()});
      await first.write('selected_demo_account', {'account': 'a'});
      await first.write(draftA, {'draft_id': 'draft_demo_a'});
      await first.write(draftB, {'draft_id': 'draft_demo_b'});
      await first.write('$scopeA:run:draft_demo_a', {'run_id': 'run_demo_a'});
      await first.write('$scopeA:cleared:pending', {});

      await first.clear(preservePendingOperations: true);
      final restored = await reopen();
      expect(await restored.read(pendingA), {'operation': originalA.toJson()});
      expect(await restored.read(pendingB), {'operation': originalB.toJson()});
      for (final key in [
        'selected_demo_account',
        draftA,
        draftB,
        '$scopeA:run:draft_demo_a',
        '$scopeA:cleared:pending',
      ]) {
        expect(
          await restored.read(key),
          isNull,
          reason: '$key must be cleared on disk',
        );
      }
    },
  );

  test(
    'ordinary clear removes pending operations as well as cached state on disk',
    () async {
      final first = await reopen();
      await first.write(pendingA, {
        'operation': operation('demo_key_a').toJson(),
      });
      await first.write(pendingB, {
        'operation': operation('demo_key_b').toJson(),
      });
      await first.write('selected_demo_account', {'account': 'b'});
      await first.write(draftA, {'draft_id': 'draft_demo_a'});

      await first.clear();
      final restored = await reopen();
      for (final key in [pendingA, pendingB, 'selected_demo_account', draftA]) {
        expect(
          await restored.read(key),
          isNull,
          reason: '$key must not survive clear()',
        );
      }
    },
  );
}
