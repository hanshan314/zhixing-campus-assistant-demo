import 'dart:convert';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/ui/message_center.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'controller_test.dart' show World, clone;

class _Messages extends World {
  bool failList = false;
  bool empty = false;
  int reads = 0;
  late final Json message = {
    'notification_id': 'notification_widget_a',
    'recipient_user_id': (entities['identity'] as Map)['user_id'],
    'event_id': 'event_widget_a',
    'kind': 'review_feedback',
    'title': '新能源实践材料审核与补正结果的较长站内消息标题',
    'target': {'kind': 'task', 'id': id},
    'delivery_status': 'stored', 'read_status': 'unread',
    'resource_version': 1, 'created_at': '2026-10-15T20:00:00+08:00',
    'read_at': null,
  };
  @override
  Future<http.Response> handle(http.Request request) async {
    final path = request.url.path;
    if (path == '/v1/me/notifications') {
      if (failList) {
        return http.Response(jsonEncode({
          'error': {'code': 'SERVICE_UNAVAILABLE', 'message': '消息服务暂时不可用'},
          'meta': {'mode': 'demo', 'request_id': 'req_widget_failed'},
        }), 503, headers: {'content-type': 'application/json'});
      }
      return reply(page(empty ? [] : [message]));
    }
    if (path == '/v1/notifications/notification_widget_a') return reply(message);
    if (path == '/v1/notifications/notification_widget_a/read') {
      reads++;
      message.addAll({'read_status': 'read', 'read_at': '2026-10-15T20:01:00+08:00', 'resource_version': 2});
      return reply(message);
    }
    if (path == '/v1/me/profile') {
      return reply({'user_id': (entities['identity'] as Map)['user_id'], 'visible_fields': [], 'facts': []});
    }
    return super.handle(request);
  }
  AppController createController() => AppController(
    api: ApiClient(origin: 'http://127.0.0.1:18765', client: MockClient(handle)),
    journal: MemoryJournal(),
  );
}

Future<void> _tap(WidgetTester t, Finder finder) async {
  await t.ensureVisible(finder);
  await t.pumpAndSettle();
  expect(finder.hitTestable(), findsOneWidget);
  await t.tap(finder);
  await t.pumpAndSettle();
}

Future<void> _mountMessages(WidgetTester t, AppController c) async {
  await c.login('a');
  await t.pumpWidget(MaterialApp(home: Builder(builder: (context) => Scaffold(
    body: TextButton(onPressed: () => showMessageCenter(context, c), child: const Text('打开消息')),
  ))));
  await _tap(t, find.text('打开消息'));
}

void main() {
  for (final width in [360.0, 390.0, 430.0]) {
    testWidgets('message read and current task deep link fit ${width.toInt()}px enlarged text', (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 844);
      t.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(t.view.resetDevicePixelRatio);
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final world = _Messages();
      final controller = world.createController();
      addTearDown(controller.dispose);
      await _mountMessages(t, controller);
      expect(find.text('本人已加载 1 条消息'), findsOneWidget);
      expect(find.text('站内已保存'), findsOneWidget);
      final initialState = clone(Map<String, dynamic>.from(world.task['student_state'] as Map));
      await _tap(t, find.text('标记消息已读'));
      expect(world.reads, 1);
      expect(find.text('已读'), findsOneWidget);
      expect(world.task['student_state'], initialState);
      expect(controller.receipt, isNull);
      await _tap(t, find.text('查看关联任务'));
      expect(controller.task?.id, world.id);
      expect(controller.task!.state['confirmation_status'], initialState['confirmation_status']);
      expect(world.submitCalls, 0);
      expect(find.byType(BottomSheet), findsNothing);
      expect(t.takeException(), isNull);
    });
  }

  testWidgets('message failure retries, empty state remains truthful, logout invalidates private sheet', (t) async {
    final world = _Messages()..failList = true;
    final c = world.createController();
    addTearDown(c.dispose);
    await _mountMessages(t, c);
    expect(find.text('消息暂时无法读取或操作'), findsOneWidget);
    expect(find.text('本人已加载 0 条消息'), findsNothing);
    world.failList = false;
    world.empty = true;
    await _tap(t, find.text('重新读取消息'));
    expect(find.text('当前没有已加载的消息'), findsOneWidget);
    world.empty = false;
    await c.loadNotifications(); await t.pumpAndSettle();
    expect(find.text(world.message['title'] as String), findsOneWidget);
    await c.logout(); await t.pumpAndSettle();
    expect(find.text(world.message['title'] as String), findsNothing);
    expect(find.text('预览已失效'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('profile remains empty until server returns confirmed visible own facts', (t) async {
    final world = _Messages(), c = world.createController();
    addTearDown(c.dispose);
    await c.login('a');
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child:
      AnimatedBuilder(animation: c, builder: (_, _) => ConfirmedProfilePanel(controller: c)),
    ))));
    expect(find.text('尚未读取已确认资料。登录姓名不自动作为已确认档案。'), findsOneWidget);
    await _tap(t, find.text('读取本人已确认资料'));
    expect(find.text('暂无可见的已确认资料'), findsOneWidget);
    expect(find.text((c.identity!['display_name']).toString()), findsNothing);
    final self = c.identity!['user_id'];
    c.profile = {'visible_fields': ['verified_field'], 'facts': [
      {'user_id': 'someone_else', 'field': 'verified_field', 'value': 'other_private_value'},
      {'user_id': self, 'field': 'hidden_field', 'value': 'hidden_private_value'},
    ]};
    await t.pumpWidget(MaterialApp(home: Scaffold(body: SingleChildScrollView(child:
      ConfirmedProfilePanel(controller: c),
    ))));
    await t.pumpAndSettle();
    expect(find.text('other_private_value'), findsNothing);
    expect(find.text('hidden_private_value'), findsNothing);
    expect(find.text('暂无可见的已确认资料'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
