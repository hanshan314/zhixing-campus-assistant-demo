import 'dart:io';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:flutter_test/flutter_test.dart';
import 'upload_recovery_test.dart' show RecoveryServer, taskId;

void main() {
  late RecoveryServer server;
  late AppController c;
  late MemoryJournal journal;
  setUp(() async {
    final root = Directory('../.local').absolute;
    await root.create(recursive: true);
    server = RecoveryServer(await root.createTemp('notification-flow-'));
    await server.start();
    journal = MemoryJournal();
    c = AppController(
      api: ApiClient(origin: server.origin),
      journal: journal,
    );
    await c.login('a');
  });
  tearDown(() async {
    c.dispose();
    await server.stop();
  });
  String currentMessage() =>
      c.notifications.firstWhere(
            (n) => (n['target'] as Map)['id'] == taskId,
          )['notification_id']
          as String;

  test(
    'in-app delivery, notification reading and task confirmation are separate facts',
    () async {
      await c.loadNotifications();
      expect(c.error, isNull);
      expect(c.notifications, hasLength(4));
      final message = c.notifications.first;
      expect(message['delivery_status'], 'stored');
      expect(message['read_status'], 'unread');
      final id = currentMessage();
      await c.readNotification(id);
      expect(c.error, isNull);
      expect(
        c.notifications.firstWhere(
          (n) => n['notification_id'] == id,
        )['read_status'],
        'read',
      );
      final task = await c.api.request('GET', '/v1/tasks/$taskId');
      expect((task['student_state'] as Map)['read_status'], 'unread');
      expect((task['student_state'] as Map)['confirmation_status'], 'pending');
      expect((task['student_state'] as Map)['submission_status'], 'none');
      await c.openNotification(id);
      expect(c.task!.id, taskId);
      expect(c.task!.state['read_status'], 'read');
      expect(c.task!.state['confirmation_status'], 'pending');
      expect(c.receipt, isNull);
    },
  );
  test(
    'old notification deep link refreshes withdrawn task and cannot authorize a submission',
    () async {
      await c.loadNotifications();
      final id = currentMessage();
      await c.api.request(
        'POST',
        '/__demo/scenario',
        control: true,
        body: {'scenario': 'withdraw_task', 'task_id': taskId},
      );
      await c.openNotification(id);
      expect(c.error, isNull);
      expect(c.task!.status, 'withdrawn');
      expect(c.task!.actions, isNot(contains('submit')));
      expect(c.task!.state['confirmation_status'], 'pending');
    },
  );
  test(
    'lost read receipt is restored with the original key after reopening the client',
    () async {
      await c.loadNotifications();
      final id = currentMessage();
      await c.setScenario('drop_next_notification_response');
      await c.readNotification(id);
      expect(c.pending!.action, 'read_notification');
      final key = c.pending!.key;
      final params = c.pending!.body;
      c.dispose();
      c = AppController(
        api: ApiClient(origin: server.origin),
        journal: journal,
      );
      await c.initialize();
      expect(c.pending!.key, key);
      expect(c.pending!.body, params);
      await c.reconcile();
      expect(c.error, isNull);
      expect(c.pending, isNull);
      expect(
        c.notifications.singleWhere(
          (n) => n['notification_id'] == id,
        )['read_status'],
        'read',
      );
      await c.openNotification(id);
      expect(c.task!.state['confirmation_status'], 'pending');
    },
  );
  test(
    'messages and confirmed profile facts remain scoped across account changes',
    () async {
      await c.loadNotifications();
      final aId = currentMessage();
      await c.loadProfile();
      expect(c.profile!['user_id'], 'user_demo_a');
      expect(c.profile!['facts'], isEmpty);
      await c.login('b');
      expect(c.notifications, isEmpty);
      expect(c.profile, isNull);
      await c.readNotification(aId);
      expect(c.error, isNotNull);
      expect(c.pending, isNull);
      await c.loadNotifications();
      expect(
        c.notifications.every((n) => n['recipient_user_id'] == 'user_demo_b'),
        isTrue,
      );
      await c.loadProfile();
      expect(c.profile!['user_id'], 'user_demo_b');
      expect(c.profile!['facts'], isEmpty);
    },
  );
  test(
    'changed requirements emit a distinct stable event and restart does not duplicate initial notifications',
    () async {
      await c.loadNotifications();
      expect(c.notifications, hasLength(4));
      await c.api.request(
        'POST',
        '/__demo/scenario',
        control: true,
        body: {'scenario': 'requirements_changed', 'task_id': taskId},
      );
      await c.loadNotifications();
      expect(c.notifications, hasLength(5));
      final change = c.notifications.singleWhere(
        (n) => n['kind'] == 'requirements_changed',
      );
      await c.openNotification(change['notification_id'] as String);
      expect(c.task!.requirementVersion, 2);
      final port = Uri.parse(server.origin).port.toString();
      c.dispose();
      await server.stop();
      await server.start(fixedPort: port);
      c = AppController(
        api: ApiClient(origin: server.origin),
        journal: journal,
      );
      await c.initialize();
      await c.loadNotifications();
      expect(c.notifications, hasLength(5));
      expect(c.notifications.map((n) => n['event_id']).toSet(), hasLength(5));
    },
  );
}
