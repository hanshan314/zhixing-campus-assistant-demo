import 'dart:async';
import 'dart:typed_data';
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/domain/models.dart';
import 'package:campus_student/ui/campus_app.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'controller_test.dart' show World, prepare;

class _RecoveryController extends AppController {
  _RecoveryController(World w)
    : super(
        api: ApiClient(
          origin: 'http://127.0.0.1:18765',
          client: MockClient(w.handle),
        ),
        journal: MemoryJournal(),
      );
  String? originalTask;
  String? originalDraft;
  int binds = 0, lookups = 0, downloads = 0;
  Completer<Uint8List?>? downloadGate;
  @override
  String? get savedUploadTaskId => originalTask;
  @override
  String? get savedUploadDraftId => originalDraft;
  @override
  Future<void> bindSavedUpload() async {
    binds++;
    draft!['file_ids'] = [savedUpload!['file_id']];
    files = [savedUpload!];
    uploadRecoveryStatus = 'bound';
    notifyListeners();
  }

  @override
  Future<void> reconcile() async {
    lookups++;
  }

  @override
  Future<Uint8List?> downloadFile(String id) async {
    downloads++;
    return downloadGate == null ? Uint8List.fromList([1, 2, 3]) : downloadGate!.future;
  }
}

class _Picker extends FilePickerPlatform {
  int calls = 0;
  Uri? result;
  @override
  Future<Uri?> saveFile({
    required String fileName,
    required Uint8List bytes,
    required String mimeType,
    String? dialogTitle,
    String? initialDirectory,
    Function(FilePickerStatus)? onFileSaving,
    WindowsOptions windowsOptions = const WindowsOptions(),
    LinuxOptions linuxOptions = const LinuxOptions(),
    WebOptions webOptions = const WebOptions(),
  }) async {
    calls++;
    expect(bytes, [1, 2, 3]);
    return result;
  }
}

Future<void> _tap(WidgetTester t, Finder finder) async {
  await t.ensureVisible(finder);
  await t.pumpAndSettle();
  expect(finder.hitTestable(), findsOneWidget);
  await t.tap(finder);
  await t.pumpAndSettle();
}

void main() {
  late World world;
  late _RecoveryController c;
  late _Picker picker;
  late FilePickerPlatform prior;
  setUp(() async {
    world = World();
    c = _RecoveryController(world);
    await prepare(world, c);
    c.originalTask = c.task!.id;
    c.originalDraft = c.draft!['draft_id'] as String;
    picker = _Picker();
    prior = FilePickerPlatform.instance;
    FilePickerPlatform.instance = picker;
  });
  tearDown(() {
    c.dispose();
    FilePickerPlatform.instance = prior;
  });

  testWidgets(
    'saved unbound material disables new uploads and binds through the original recovery action',
    (t) async {
      t.view.physicalSize = const Size(360, 844);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.view.resetDevicePixelRatio);
      c.savedUpload = Map<String, dynamic>.from(world.entities['file'] as Map);
      c.uploadRecoveryStatus = 'saved_unbound';
      c.draft!['file_ids'] = [];
      c.files = [];
      await t.pumpWidget(CampusApp(controller: c));
      await t.pumpAndSettle();
      expect(find.text('文件已保存，尚未加入草稿'), findsOneWidget);
      final upload = t.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, '选择 PDF'),
      );
      expect(upload.onPressed, isNull);
      final submit = t.widget<FilledButton>(
        find.widgetWithText(FilledButton, '预览材料并正式提交'),
      );
      expect(submit.onPressed, isNull);
      await _tap(t, find.text('将已保存文件加入原草稿'));
      expect(c.binds, 1);
      expect(world.submitCalls, 0);
      expect(find.text('文件已保存并加入原草稿'), findsOneWidget);
      expect(find.text(c.savedUpload!['filename'] as String), findsOneWidget);
      expect(t.takeException(), isNull);
    },
  );
  testWidgets(
    'a file for another task cannot be silently attached to the displayed draft',
    (t) async {
      c.savedUpload = Map<String, dynamic>.from(world.entities['file'] as Map);
      c.originalTask = 'another_task';
      c.uploadRecoveryStatus = 'saved_unbound';
      await t.pumpWidget(CampusApp(controller: c));
      await t.pumpAndSettle();
      expect(
        t
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, '将已保存文件加入原草稿'),
            )
            .onPressed,
        isNull,
      );
      expect(find.text('打开原任务'), findsOneWidget);
      expect(c.binds, 0);
    },
  );
  testWidgets(
    'unknown upload retains a lookup action without creating a new intent',
    (t) async {
      c.uploadRecoveryStatus = 'unknown';
      c.pending = PendingOperation(
        key: 'original_upload_key',
        action: 'upload_file',
        targetId: world.id,
        path: '/v1/files',
        body: {'purpose': 'submission_material', 'task_id': world.id},
      );
      await t.pumpWidget(CampusApp(controller: c));
      await t.pumpAndSettle();
      expect(find.text('文件保存结果待确认'), findsOneWidget);
      await _tap(t, find.text('查询原操作结果'));
      expect(c.lookups, 1);
      expect(c.pending!.key, 'original_upload_key');
      expect(world.submitCalls, 0);
    },
  );
  for (final saved in [false, true]) {
    testWidgets(
      'device save ${saved ? 'returns URI' : 'cancelled'} is distinct from a business receipt',
      (t) async {
        picker.result = saved ? Uri.parse('content://test/material') : null;
        await t.pumpWidget(CampusApp(controller: c));
        await t.pumpAndSettle();
        await _tap(t, find.text('保存原文件到设备').first);
        expect(picker.calls, 1);
        expect(c.receipt, isNull);
        expect(world.submitCalls, 0);
        expect(
          find.textContaining(saved ? '系统已返回原文件保存位置' : '已取消保存原文件'),
          findsOneWidget,
        );
        expect(t.takeException(), isNull);
      },
    );
  }
  testWidgets('late bytes after logout never reach the device file picker', (
    t,
  ) async {
    c.downloadGate = Completer<Uint8List?>();
    await t.pumpWidget(CampusApp(controller: c));
    await t.pumpAndSettle();
    await t.ensureVisible(find.text('保存原文件到设备').first);
    await t.pumpAndSettle();
    await t.tap(find.text('保存原文件到设备').first);
    await t.pump();
    expect(c.downloads,1);
    await c.logout();
    await t.pumpAndSettle();
    c.downloadGate!.complete(Uint8List.fromList([1, 2, 3]));
    await t.pumpAndSettle();
    expect(picker.calls, 0);
    expect(c.identity, isNull);
    expect(t.takeException(), isNull);
  });
}
