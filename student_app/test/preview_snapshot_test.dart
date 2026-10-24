import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/ui/campus_app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'controller_test.dart' show World, prepare;

Future<void> openPreview(WidgetTester tester, AppController c) async {
  await tester.pumpWidget(CampusApp(controller: c));
  await tester.pumpAndSettle();
  final button = find.text('预览材料并正式提交');
  await tester.ensureVisible(button);
  await tester.pumpAndSettle();
  await tester.tap(button);
  await tester.pumpAndSettle();
  expect(find.byType(BottomSheet), findsOneWidget);
}

Finder inSheet(Finder finder) =>
    find.descendant(of: find.byType(BottomSheet), matching: finder);

void main() {
  testWidgets('401 removes private preview content without submitting', (
    tester,
  ) async {
    final world = World();
    final c = world.controller(MemoryJournal());
    addTearDown(c.dispose);
    await prepare(world, c);
    await openPreview(tester, c);
    expect(inSheet(find.text(world.task['title'] as String)), findsOneWidget);
    world.unauthorized = true;
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('预览已失效'), findsOneWidget);
    expect(inSheet(find.text(world.task['title'] as String)), findsNothing);
    expect(inSheet(find.text('提交这 1 份材料')), findsNothing);
    expect(world.submitCalls, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'display fields remain frozen and a requirement change expires preview',
    (tester) async {
      final world = World();
      final c = world.controller(MemoryJournal());
      addTearDown(c.dispose);
      await prepare(world, c);
      final originalTitle = c.task!.title;
      await openPreview(tester, c);
      world.task['title'] = 'later refreshed title';
      await c.refresh();
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(780, 1000);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpAndSettle();
      expect(inSheet(find.text(originalTitle)), findsOneWidget);
      expect(inSheet(find.text('later refreshed title')), findsNothing);
      world.task['requirement_version'] = 2;
      await c.refresh();
      await tester.pumpAndSettle();
      expect(find.text('预览已失效'), findsOneWidget);
      expect(inSheet(find.text(originalTitle)), findsNothing);
      expect(world.submitCalls, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'account change removes private original-operation retry dialog',
    (tester) async {
      final world = World()..loseBeforeSave = true;
      final c = world.controller(MemoryJournal());
      addTearDown(c.dispose);
      await prepare(world, c);
      await c.submit();
      world.lookupStatus = 'not_found';
      world.lookupOutcome = 'unknown';
      await c.reconcile();
      await tester.pumpWidget(CampusApp(controller: c));
      await tester.pumpAndSettle();
      final retry = find.widgetWithText(OutlinedButton, '按原操作重试');
      await tester.ensureVisible(retry);
      await tester.pumpAndSettle();
      await tester.tap(retry);
      await tester.pumpAndSettle();
      expect(find.text('使用原参数重试'), findsOneWidget);
      await c.login('b');
      await tester.pumpAndSettle();
      expect(find.text('预览已失效'), findsOneWidget);
      expect(find.text('使用原参数重试'), findsNothing);
      expect(find.text('目标编号'), findsNothing);
      expect(world.submitCalls, 1);
      expect(tester.takeException(), isNull);
    },
  );
}
