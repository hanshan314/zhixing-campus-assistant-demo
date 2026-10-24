import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/ui/campus_app.dart';
import 'package:campus_student/ui/components.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'controller_test.dart' show World, prepare;

/// Reuses the real contract fixture and MockClient-backed controller. Only the
/// supported upload capability and long display values differ from World.
class _LayoutWorld extends World {
  _LayoutWorld() {
    task['title'] = '虚拟班级校园实践与新能源志愿服务材料收集及个人总结核对';
    task['description'] =
        '这是一项用于布局验证的虚拟任务。请核对原文、接收范围和版本，'
        '保存文件后仍须明确确认正式提交。\n较长通知应完整换行，不挤出操作入口。';
    (task['audience'] as Map)['description'] =
        '虚拟班级固定三十人名单快照，仅向获得本项材料审核权限的班干部开放';
    (entities['file'] as Map)['filename'] =
        '新能源校园实践与志愿服务个人总结及补充说明材料_仅用于布局验证的虚拟文件.pdf';
  }

  @override
  Future<http.Response> handle(http.Request request) {
    if (request.url.path == '/v1/capabilities') {
      calls.add('${request.method} ${request.url.path}');
      return Future.value(
        reply({
          'upload': {
            'available': true,
            'max_bytes': 10485760,
            'supported_mime_types': ['application/pdf'],
          },
        }),
      );
    }
    return super.handle(request);
  }
}

void _setViewport(WidgetTester tester, double width, double scale) {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 844);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

void _expectNoLayoutError(WidgetTester tester, String stage) {
  expect(
    tester.takeException(),
    isNull,
    reason: 'Framework/layout error at $stage',
  );
}

Future<void> _settle(WidgetTester tester, String stage) async {
  await tester.pumpAndSettle();
  _expectNoLayoutError(tester, stage);
}

Future<void> _reveal(WidgetTester tester, Finder finder, String stage) async {
  expect(finder, findsOneWidget, reason: '$stage must exist');
  await tester.ensureVisible(finder);
  await _settle(tester, stage);
  expect(
    finder.hitTestable(),
    findsOneWidget,
    reason: '$stage must be reachable',
  );
}

Future<void> _tap(WidgetTester tester, Finder finder, String stage) async {
  await _reveal(tester, finder, stage);
  await tester.tap(finder);
  await _settle(tester, stage);
}

Future<void> _mount(WidgetTester tester, AppController controller) async {
  // Resolve the real bundled asset outside FakeAsync; the UI still invokes its
  // upload action and sends the bytes through the MockClient-backed repository.
  await tester.runAsync(() => rootBundle.load('assets/demo-practice.pdf'));
  await controller.initialize();
  await tester.pumpWidget(CampusApp(controller: controller));
  await _settle(tester, 'login page');
}

Finder _insidePreview(Finder finder) =>
    find.descendant(of: find.byType(BottomSheet), matching: finder);

void main() {
  for (final width in [360.0, 390.0, 430.0]) {
    for (final scale in [1.0, 1.5]) {
      testWidgets(
        'real app flow fits ${width.toInt()}px at text scale $scale and requires confirmation',
        (tester) async {
          _setViewport(tester, width, scale);
          final world = _LayoutWorld();
          final controller = world.controller(MemoryJournal());
          addTearDown(controller.dispose);
          await _mount(tester, controller);

          expect(find.text('演示环境 · 仅虚拟材料'), findsOneWidget);
          await _tap(tester, find.text('以虚拟学生甲 · A 进入'), 'login button');
          expect(controller.error, isNull);
          expect(controller.identity, isNotNull);
          expect(world.submitCalls, 0);

          await _tap(tester, find.text('待办'), 'task-list destination');
          expect(find.text('把每件事，\n安放在进度里。'), findsOneWidget);
          expect(find.byType(TaskTile), findsOneWidget);
          await _tap(
            tester,
            find.text(world.task['title'] as String),
            'long task title',
          );
          expect(controller.task?.id, world.id);
          expect(find.text('任务详情'), findsOneWidget);
          expect(find.text('尚未正式提交'), findsOneWidget);
          await _reveal(tester, find.text('保留原文，方便核对'), 'original notice');

          await _tap(tester, find.text('建立材料草稿'), 'create draft');
          expect(controller.draft, isNotNull);
          await _tap(tester, find.text('使用虚拟示例 PDF'), 'save bundled PDF');
          expect(controller.error, isNull);
          expect(controller.files, hasLength(1));
          expect(controller.task!.state['submission_status'], 'none');
          expect(controller.receipt, isNull);
          expect(world.submission, isNull);
          expect(
            world.submitCalls,
            0,
            reason: 'Saving a file must not submit it',
          );
          expect(find.text('已保存 1 份文件'), findsOneWidget);
          await _reveal(
            tester,
            find.text((world.entities['file'] as Map)['filename'] as String),
            'long saved filename',
          );

          await _tap(tester, find.text('预览材料并正式提交'), 'open formal preview');
          expect(find.byType(BottomSheet), findsOneWidget);
          expect(_insidePreview(find.text('核对后，再提交。')), findsOneWidget);
          expect(_insidePreview(find.text('接收范围')), findsOneWidget);
          expect(_insidePreview(find.text('要求 v1 · 草稿 v2')), findsOneWidget);
          expect(_insidePreview(find.text('本次提交的 1 份材料')), findsOneWidget);
          expect(
            world.submitCalls,
            0,
            reason: 'Opening a preview is not consent',
          );

          await _tap(
            tester,
            _insidePreview(find.text('返回修改')),
            'cancel preview',
          );
          expect(find.byType(BottomSheet), findsNothing);
          expect(world.submitCalls, 0);
          expect(controller.task!.state['submission_status'], 'none');

          await _tap(tester, find.text('预览材料并正式提交'), 'reopen preview');
          await _tap(
            tester,
            _insidePreview(find.text('提交这 1 份材料')),
            'explicit formal confirmation',
          );
          expect(controller.error, isNull);
          expect(world.submitCalls, 1);
          expect(controller.pending, isNull);
          expect(controller.task!.state['submission_status'], 'submitted');
          expect(controller.task!.state['review_status'], 'pending');
          expect(
            controller.receipt?['submission_id'],
            world.submission!['submission_id'],
          );
          expect(find.text('当前版本审核通过'), findsNothing);
          await _reveal(tester, find.text('提交回执'), 'submission receipt');
          await _reveal(tester, find.text('提交历史'), 'submission history');
          expect(find.text('当前有效版本'), findsWidgets);
          expect(
            world.checkCalls,
            0,
            reason: 'AI checks must not become a hidden submit gate',
          );
          _expectNoLayoutError(tester, 'completed flow');
          await tester.pumpWidget(const SizedBox.shrink());
        },
      );
    }
  }

  testWidgets(
    '360px enlarged text keeps draft editing usable above keyboard and safe areas',
    (tester) async {
      _setViewport(tester, 360, 1.5);
      tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
      tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 24);
      addTearDown(tester.view.resetPadding);
      addTearDown(tester.view.resetViewPadding);
      addTearDown(tester.view.resetViewInsets);

      final world = _LayoutWorld();
      final controller = world.controller(MemoryJournal());
      addTearDown(controller.dispose);
      await prepare(world, controller);
      await tester.pumpWidget(CampusApp(controller: controller));
      await _settle(tester, 'prepared saved draft');

      final input = find.byType(TextField);
      await _reveal(tester, input, 'draft explanation field');
      await tester.showKeyboard(input);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      tester.view.padding = const FakeViewPadding(top: 24);
      await _settle(tester, 'keyboard and safe area');
      const explanation =
          '这段补充说明只属于当前草稿，保存后仍需核对接收范围、文件和版本，'
          '再由学生明确确认正式提交。长文本应能编辑和滚动查看。';
      await tester.enterText(input, explanation);
      await _settle(tester, 'long explanation input');

      final previewButton = find.ancestor(
        of: find.text('预览材料并正式提交'),
        matching: find.byWidgetPredicate(
          (widget) => widget is ButtonStyleButton,
        ),
      );
      expect(
        tester.widget<ButtonStyleButton>(previewButton).onPressed,
        isNull,
        reason: 'Unsaved explanation cannot be silently submitted',
      );

      final save = find.text('保存说明');
      await _reveal(tester, save, 'save explanation above keyboard');
      expect(tester.getBottomLeft(save).dy, lessThanOrEqualTo(844 - 300));
      await tester.tap(save);
      await _settle(tester, 'save explanation');
      expect(controller.error, isNull);
      expect(controller.draft?['text'], explanation);
      expect(controller.task!.state['submission_status'], 'none');
      expect(world.submitCalls, 0);
      expect(controller.receipt, isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
