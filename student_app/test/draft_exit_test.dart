import 'dart:async';
import 'dart:convert';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/ui/campus_app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'controller_test.dart' show World, prepare;

class _SaveWorld extends World {
  bool rejectSave = false;
  @override
  Future<http.Response> handle(http.Request request) async {
    if (rejectSave && request.method == 'PATCH') {
      calls.add('${request.method} ${request.url.path}');
      return http.Response(
        jsonEncode({
          'error': {
            'code': 'RESOURCE_VERSION_CONFLICT',
            'message': '草稿已变化',
            'retryable': false,
            'details': {},
          },
          'meta': {'mode': 'demo', 'request_id': 'req_save_conflict'},
        }),
        409,
      );
    }
    return super.handle(request);
  }
}

class _ReplacementWorld extends _SaveWorld {
  _ReplacementWorld() {
    submission = Map<String, dynamic>.from(entities['submission'] as Map);
    submission!['draft_id'] = 'draft_qa_previous_submission';
    (task['student_state'] as Map).addAll(<String, dynamic>{
      'submission_status': 'submitted',
      'effective_submission_id': submission!['submission_id'],
      'review_status': 'pending',
      'display_status': 'submitted_pending_review',
      'allowed_actions': [
        'prepare_revision',
        'upload',
        'check',
        'submit',
        'view_source',
        'view_history',
      ],
    });
  }

  int createdDrafts = 0;
  final createBodies = <Map<String, dynamic>>[];
  final savedDrafts = <String, Map<String, dynamic>>{};
  final patchBodies = <Map<String, dynamic>>[];
  final writeOrder = <String>[];
  Completer<void>? saveGate;

  @override
  Future<http.Response> handle(http.Request request) async {
    if (request.method == 'POST' &&
        request.url.path.endsWith('/submission-drafts')) {
      createdDrafts++;
      writeOrder.add('POST replacement');
      createBodies.add(
        Map<String, dynamic>.from(jsonDecode(request.body) as Map),
      );
      // The shared World reuses one fixture ID. A real replacement returns a
      // different ID; keep that distinction so input loss cannot be concealed.
      (entities['draft'] as Map)['draft_id'] =
          'draft_qa_revision_$createdDrafts';
    }
    if (request.method == 'PATCH' &&
        request.url.path.startsWith('/v1/submission-drafts/')) {
      patchBodies.add(
        Map<String, dynamic>.from(jsonDecode(request.body) as Map),
      );
      writeOrder.add('PATCH ${request.url.path}');
      if (saveGate != null) await saveGate!.future;
    }
    final response = await super.handle(request);
    if (response.statusCode < 300 &&
        draft != null &&
        (request.method == 'POST' || request.method == 'PATCH')) {
      savedDrafts[draft!['draft_id'] as String] = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(draft)) as Map,
      );
    }
    return response;
  }
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

const _replacementText = '补交草稿里的独立验收说明，未经选择不能丢失';
const _saveReplacement = '保存原草稿后新建';
const _discardReplacement = '放弃修改并新建';

Future<AppController> _showReplacement(
  WidgetTester tester,
  _ReplacementWorld world, {
  bool dirty = true,
}) async {
  final controller = world.controller(MemoryJournal());
  addTearDown(controller.dispose);
  await prepare(world, controller);
  expect(
    controller.task!.effectiveSubmission,
    world.submission!['submission_id'],
  );
  expect(
    controller.draft!['revision_of_submission_id'],
    world.submission!['submission_id'],
  );
  await tester.pumpWidget(CampusApp(controller: controller));
  await tester.pumpAndSettle();
  if (dirty) {
    await tester.ensureVisible(find.byType(TextField));
    await tester.enterText(find.byType(TextField), _replacementText);
    await tester.pump();
  }
  return controller;
}

String _editorText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  testWidgets(
    'dirty revision draft replacement requires an explicit choice before a new draft is posted',
    (tester) async {
      final world = _ReplacementWorld();
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      final oldDraftId = controller.draft!['draft_id'];
      final effectiveSubmission = controller.task!.effectiveSubmission;
      expect(effectiveSubmission, world.submission!['submission_id']);
      expect(
        controller.draft!['revision_of_submission_id'],
        effectiveSubmission,
      );
      expect(world.createdDrafts, 1);
      await tester.pumpWidget(CampusApp(controller: controller));
      await tester.pumpAndSettle();
      const unsaved = '补交说明还没有保存，不能直接替换丢失';
      await tester.ensureVisible(find.byType(TextField));
      await tester.enterText(find.byType(TextField), unsaved);
      await tester.pump();
      expect(find.text(unsaved), findsOneWidget);
      expect(find.text('说明文字尚未保存'), findsOneWidget);
      await _tap(tester, find.text('建立新版本草稿'));
      final visibleText = tester
          .widget<TextField>(find.byType(TextField))
          .controller!
          .text;
      debugPrint(
        'QA draft replacement observation: ${jsonEncode({'old_draft_id': oldDraftId, 'current_draft_id': controller.draft?['draft_id'], 'draft_post_count': world.createdDrafts, 'draft_post_bodies': world.createBodies, 'unsaved_input': unsaved, 'visible_text_after_click': visibleText, 'effective_submission_id': controller.task?.effectiveSubmission, 'formal_submit_calls': world.submitCalls})}',
      );
      expect(
        world.createdDrafts,
        1,
        reason:
            'No replacement draft POST is allowed before a save/discard choice',
      );
      expect(controller.draft!['draft_id'], oldDraftId);
      expect(visibleText, unsaved);
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(controller.task!.effectiveSubmission, effectiveSubmission);
      expect(world.submitCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  for (final choice in ['继续编辑', _saveReplacement, _discardReplacement]) {
    testWidgets(
      'revision replacement $choice honors the choice and retains the formal submission',
      (tester) async {
        final world = _ReplacementWorld();
        final controller = await _showReplacement(tester, world);
        final oldId = controller.draft!['draft_id'] as String;
        final oldVersion = controller.draft!['draft_version'] as int;
        final oldFiles = List<String>.from(
          controller.draft!['file_ids'] as List,
        );
        final oldSubmission = jsonEncode(world.submission);
        final writesBefore = world.writeOrder.length;
        final patchesBefore = world.patchBodies.length;
        await _tap(tester, find.text('建立新版本草稿'));
        expect(world.createdDrafts, 1);
        expect(_editorText(tester), _replacementText);
        await _tap(tester, find.text(choice));

        if (choice == '继续编辑') {
          expect(world.createdDrafts, 1);
          expect(world.patchBodies.length, patchesBefore);
          expect(controller.draft!['draft_id'], oldId);
          expect(_editorText(tester), _replacementText);
          await tester.enterText(find.byType(TextField), '继续编辑仍可输入');
          expect(_editorText(tester), '继续编辑仍可输入');
        } else {
          expect(world.createdDrafts, 2);
          expect(controller.draft!['draft_id'], isNot(oldId));
          expect(controller.draft!['text'], '');
          expect(controller.draft!['file_ids'], isEmpty);
          expect(_editorText(tester), '');
          expect(
            controller.draft!['revision_of_submission_id'],
            world.submission!['submission_id'],
          );
          final prior = world.savedDrafts[oldId]!;
          expect(prior['file_ids'], oldFiles);
          if (choice == _saveReplacement) {
            expect(world.patchBodies.length, patchesBefore + 1);
            expect(prior['text'], _replacementText);
            expect(prior['draft_version'], oldVersion + 1);
            expect(world.patchBodies.last['draft_version'], oldVersion);
            expect(world.patchBodies.last['text'], _replacementText);
            expect(world.writeOrder.skip(writesBefore).toList(), [
              'PATCH /v1/submission-drafts/$oldId',
              'POST replacement',
            ]);
          } else {
            expect(world.patchBodies.length, patchesBefore);
            expect(prior['text'], '');
            expect(world.writeOrder.skip(writesBefore).toList(), [
              'POST replacement',
            ]);
          }
        }
        expect(find.byType(AlertDialog), findsNothing);
        expect(jsonEncode(world.submission), oldSubmission);
        expect(
          controller.task!.effectiveSubmission,
          world.submission!['submission_id'],
        );
        expect(world.submitCalls, 0);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'failed revision save retains the input without replacing the draft',
    (tester) async {
      final world = _ReplacementWorld();
      final controller = await _showReplacement(tester, world);
      final oldId = controller.draft!['draft_id'];
      final oldVersion = controller.draft!['draft_version'];
      final patchesBefore = world.patchBodies.length;
      world.rejectSave = true;
      await _tap(tester, find.text('建立新版本草稿'));
      await _tap(tester, find.text(_saveReplacement));
      expect(world.createdDrafts, 1);
      expect(world.patchBodies.length, patchesBefore + 1);
      expect(controller.draft!['draft_id'], oldId);
      expect(controller.draft!['draft_version'], oldVersion);
      expect(world.savedDrafts[oldId]!['text'], '');
      expect(_editorText(tester), _replacementText);
      expect(controller.error, isNotNull);
      expect(
        controller.task!.effectiveSubmission,
        world.submission!['submission_id'],
      );
      expect(world.submitCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  for (final change in [
    'account',
    'requirement',
    'draft version',
    'effective submission',
  ]) {
    testWidgets('revision replacement choice expires after $change changes', (
      tester,
    ) async {
      final world = _ReplacementWorld();
      final controller = await _showReplacement(tester, world);
      final patchesBefore = world.patchBodies.length;
      await _tap(tester, find.text('建立新版本草稿'));
      expect(find.text(_saveReplacement), findsOneWidget);
      switch (change) {
        case 'account':
          await controller.login('b');
        case 'requirement':
          world.task['requirement_version'] = 2;
          await controller.refresh();
        case 'draft version':
          world.draft!['draft_version'] =
              (world.draft!['draft_version'] as int) + 1;
          await controller.refresh();
        case 'effective submission':
          (world.task['student_state'] as Map)['effective_submission_id'] =
              'submission_qa_external_revision';
          await controller.refresh();
      }
      await tester.pumpAndSettle();
      expect(find.text(_saveReplacement), findsNothing);
      expect(find.text(_discardReplacement), findsNothing);
      expect(find.text('草稿状态已经变化'), findsOneWidget);
      await _tap(tester, find.text('返回核对'));
      expect(world.createdDrafts, 1);
      expect(world.patchBodies.length, patchesBefore);
      expect(world.submitCalls, 0);
      if (change == 'account') {
        expect(controller.account, 'b');
        expect(controller.draft, isNull);
        expect(find.text(_replacementText), findsNothing);
      } else {
        expect(_editorText(tester), _replacementText);
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'late revision save reply cannot create a draft for a new account',
    (tester) async {
      final world = _ReplacementWorld();
      final controller = await _showReplacement(tester, world);
      final oldId = controller.draft!['draft_id'];
      final patchesBefore = world.patchBodies.length;
      world.saveGate = Completer<void>();
      await _tap(tester, find.text('建立新版本草稿'));
      await tester.tap(find.text(_saveReplacement));
      await tester.pump();
      expect(world.patchBodies.length, patchesBefore + 1);
      expect(world.createdDrafts, 1);
      await controller.login('b');
      await tester.pumpAndSettle();
      world.saveGate!.complete();
      await tester.pumpAndSettle();
      expect(world.createdDrafts, 1);
      expect(world.savedDrafts[oldId]!['text'], _replacementText);
      expect(controller.account, 'b');
      expect(controller.draft, isNull);
      expect(find.text(_replacementText), findsNothing);
      expect(world.submitCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'clean revision replacement skips the dialog and repeated clicks create only one draft',
    (tester) async {
      final world = _ReplacementWorld();
      final controller = await _showReplacement(tester, world, dirty: false);
      final oldId = controller.draft!['draft_id'];
      final patchesBefore = world.patchBodies.length;
      final oldSubmission = jsonEncode(world.submission);
      await tester.ensureVisible(find.text('建立新版本草稿'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('建立新版本草稿'));
      await tester.tap(find.text('建立新版本草稿'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(world.createdDrafts, 2);
      expect(world.patchBodies.length, patchesBefore);
      expect(controller.draft!['draft_id'], isNot(oldId));
      expect(_editorText(tester), '');
      expect(jsonEncode(world.submission), oldSubmission);
      expect(world.submitCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  for (final action in ['继续编辑', '放弃修改并离开', '保存草稿并离开']) {
    testWidgets(
      'draft exit $action preserves the selected intent without submitting',
      (tester) async {
        final world = _SaveWorld();
        final controller = world.controller(MemoryJournal());
        addTearDown(controller.dispose);
        await prepare(world, controller);
        await tester.pumpWidget(CampusApp(controller: controller));
        await tester.pumpAndSettle();
        const text = '仍未正式提交的说明';
        await tester.ensureVisible(find.byType(TextField));
        await tester.enterText(find.byType(TextField), text);
        await tester.pump();
        await _tap(tester, find.byIcon(Icons.arrow_back_rounded));
        expect(find.byType(AlertDialog), findsOneWidget);
        await _tap(tester, find.text(action));
        if (action == '继续编辑') {
          expect(controller.task, isNotNull);
          expect(find.text(text), findsOneWidget);
        } else {
          expect(controller.task, isNull);
        }
        expect(world.draft!['text'], action == '保存草稿并离开' ? text : '');
        expect(world.submitCalls, 0);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('failed draft save stays on the editor with unsaved input', (
    tester,
  ) async {
    final world = _SaveWorld();
    final controller = world.controller(MemoryJournal());
    addTearDown(controller.dispose);
    await prepare(world, controller);
    world.rejectSave = true;
    await tester.pumpWidget(CampusApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byType(TextField));
    await tester.enterText(find.byType(TextField), '保存失败也不能丢失');
    await _tap(tester, find.byIcon(Icons.arrow_back_rounded));
    await _tap(tester, find.text('保存草稿并离开'));
    expect(controller.task, isNotNull);
    expect(find.text('保存失败也不能丢失'), findsOneWidget);
    expect(controller.error, isNotNull);
    expect(world.draft!['text'], '');
    expect(world.submitCalls, 0);
    expect(tester.takeException(), isNull);
  });
}
