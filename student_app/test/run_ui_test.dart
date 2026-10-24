import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:campus_student/controllers/app_controller.dart';
import 'package:campus_student/data/api_client.dart';
import 'package:campus_student/data/journal.dart';
import 'package:campus_student/ui/run_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'controller_test.dart' show World, clone;

class _RunUi extends AppController {
  _RunUi(World world):super(api:ApiClient(origin:'http://127.0.0.1:18765',client:MockClient(world.handle)),journal:MemoryJournal()) {
    entry=clone(Map<String,dynamic>.from(world.entities['run'] as Map));
    entry.addAll({'status':'waiting_input','input_fields':[{'name':'explanation','label':'补充实践材料说明与具体核对情况','required':true,'type':'text','choices':[]}],'cancellable':true,'poll_after_seconds':null});
  }
  late Json entry; List<Json>? sent; int cancellations=0,retries=0;
  @override Future<void> loadRuns()async { runs=[entry];notifyListeners(); }
  @override Future<void> openRun(String id)async { selectedRun=entry;notifyListeners(); }
  @override Future<void> supplyRunInputs(List<Json> inputs)async { sent=inputs;selectedRun={...entry,'status':'queued','input_fields':[]};notifyListeners(); }
  @override Future<void> cancelRun()async {cancellations++;}
  @override Future<void> retryRun()async {retries++;selectedRun={...entry,'run_id':'new_related_run','status':'queued','retry_of':entry['run_id']};notifyListeners();}
}
Future<void> _tap(WidgetTester t,Finder finder)async{await t.ensureVisible(finder);await t.pumpAndSettle();expect(finder.hitTestable(),findsOneWidget);await t.tap(finder);await t.pumpAndSettle();}
Future<void> _mount(WidgetTester t,_RunUi c)async{
  await c.login('a');
  await t.pumpWidget(MaterialApp(home:Builder(builder:(context)=>Scaffold(body:TextButton(onPressed:()=>showRunBrowser(context,c),child:const Text('打开记录'))))));
  await _tap(t,find.text('打开记录'));
}
void main(){
  run503Tests();
  for(final width in [360.0,390.0,430.0]){
    testWidgets('run list and waiting input remain operable at ${width.toInt()}px enlarged text',(t)async{
      t.view.devicePixelRatio=1;t.view.physicalSize=Size(width,844);t.platformDispatcher.textScaleFactorTestValue=1.5;
      addTearDown(t.view.resetDevicePixelRatio);addTearDown(t.view.resetPhysicalSize);addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final c=_RunUi(World());addTearDown(c.dispose);await _mount(t,c);
      expect(find.text('本人已加载 1 条执行记录'),findsOneWidget);await _tap(t,find.text('查看执行详情'));
      expect(find.text('等待补充信息'),findsOneWidget);
      await t.ensureVisible(find.byType(TextField));await t.enterText(find.byType(TextField),'已核对原材料');
      await _tap(t,find.text('提交补充信息'));
      expect(c.sent,[{'name':'explanation','value':'已核对原材料'}]);expect(c.receipt,isNull);
      expect(find.text('已受理，正在排队'),findsOneWidget);expect(c.cancellations,0);
      await _tap(t,find.byTooltip('关闭执行记录'));expect(c.selectedRun,isNull);expect(c.cancellations,0);expect(t.takeException(),isNull);
    });
  }
  testWidgets('failed run exposes related retry, then logout removes private execution detail',(t)async{
    final c=_RunUi(World());addTearDown(c.dispose);
    c.entry.addAll({'status':'failed','input_fields':[],'cancellable':false,'error':{'code':'AI_TIMEOUT','message':'原材料仍保留','retryable':true}});
    await _mount(t,c);await _tap(t,find.text('查看执行详情'));await _tap(t,find.text('创建关联重试执行'));
    expect(c.retries,1);expect(c.selectedRun!['retry_of'],c.entry['run_id']);
    await c.logout();await t.pumpAndSettle();expect(find.text('new_related_run'),findsNothing);expect(find.text('预览已失效'),findsOneWidget);
    expect(t.takeException(),isNull);
  });
}

class _Run503Transport {
  final world = World();
  int calls = 0;
  bool fail = true;
  bool empty = false;
  late final AppController controller = AppController(
    api: ApiClient(origin: 'http://127.0.0.1:18765', client: MockClient((request) async {
      if (request.method == 'GET' && request.url.path == '/v1/me/runs') {
        calls++;
        if (fail) {
          return http.Response(jsonEncode({
            'error': {'code': 'SERVICE_UNAVAILABLE', 'message': 'Run503列表读取失败'},
            'meta': {'request_id': 'req_run503', 'mode': 'demo'},
          }), 503, headers: {'content-type': 'application/json; charset=utf-8'});
        }
        final entry = clone(Map<String, dynamic>.from(world.entities['run'] as Map));
        entry['status'] = 'succeeded';
        return world.reply(world.page(empty ? [] : [entry]));
      }
      return world.handle(request);
    })), journal: MemoryJournal(),
  );
}

Future<void> _mountRun503(WidgetTester t, AppController c) async {
  await c.login('a');
  expect(c.error, isNull);
  await t.pumpWidget(MaterialApp(home: Builder(builder: (context) => Scaffold(
    body: TextButton(onPressed: () => showRunBrowser(context, c), child: const Text('打开记录')),
  ))));
  await _tap(t, find.text('打开记录'));
}

void run503Tests() {
  testWidgets('Run503 R1 first GET failure is not successful empty, then retry recovers', (t) async {
    final fixture = _Run503Transport();
    final c = fixture.controller;
    addTearDown(c.dispose);
    await _mountRun503(t, c);
    expect(fixture.calls, 1);
    expect(c.error, contains('Run503列表读取失败'));
    expect(find.textContaining('Run503列表读取失败'), findsOneWidget);
    expect(find.text('本人已加载 0 条执行记录'), findsNothing);
    expect(find.text('当前没有已加载的执行记录'), findsNothing);
    fixture.fail = false;
    await _tap(t, find.text('重新读取执行列表'));
    expect(fixture.calls, 2);
    expect(c.error, isNull);
    expect(find.text('本人已加载 1 条执行记录'), findsOneWidget);
    expect(find.text('当前没有已加载的执行记录'), findsNothing);
    expect(t.takeException(), isNull);
  });
  testWidgets('Run503 R2 successful empty remains an empty state', (t) async {
    final fixture = _Run503Transport()..fail = false..empty = true;
    final c = fixture.controller;
    addTearDown(c.dispose);
    await _mountRun503(t, c);
    expect(fixture.calls, 1);
    expect(c.error, isNull);
    expect(find.text('本人已加载 0 条执行记录'), findsOneWidget);
    expect(find.text('当前没有已加载的执行记录'), findsOneWidget);
    expect(find.text('重新读取执行列表'), findsNothing);
    expect(t.takeException(), isNull);
  });
  testWidgets('Run503 R3 cached rows survive refresh failure and can refresh again', (t) async {
    final fixture = _Run503Transport()..fail = false;
    final c = fixture.controller;
    addTearDown(c.dispose);
    await _mountRun503(t, c);
    final id = c.runs.single['run_id'] as String;
    fixture.fail = true;
    await t.widget<RefreshIndicator>(find.byType(RefreshIndicator)).onRefresh();
    await t.pumpAndSettle();
    expect(fixture.calls, 2);
    expect(c.error, contains('Run503列表读取失败'));
    expect(find.textContaining('Run503列表读取失败'), findsOneWidget);
    expect(find.text(id), findsOneWidget);
    expect(find.text('本人已加载 1 条执行记录'), findsOneWidget);
    fixture.fail = false;
    await t.widget<RefreshIndicator>(find.byType(RefreshIndicator)).onRefresh();
    await t.pumpAndSettle();
    expect(fixture.calls, 3);
    expect(c.error, isNull);
    expect(find.text(id), findsOneWidget);
    expect(t.takeException(), isNull);
  });
  testWidgets('Run503 R4 session change invalidates private cached list', (t) async {
    final fixture = _Run503Transport()..fail = false;
    final c = fixture.controller;
    addTearDown(c.dispose);
    await _mountRun503(t, c);
    final id = c.runs.single['run_id'] as String;
    fixture.fail = true;
    await t.widget<RefreshIndicator>(find.byType(RefreshIndicator)).onRefresh();
    await t.pumpAndSettle();
    expect(find.text(id), findsOneWidget);
    await c.login('b');
    await t.pumpAndSettle();
    expect(c.runs, isEmpty);
    expect(find.text('预览已失效'), findsOneWidget);
    expect(find.text(id), findsNothing);
    expect(find.textContaining('Run503列表读取失败'), findsNothing);
    expect(find.text('重新读取执行列表'), findsNothing);
    expect(t.takeException(), isNull);
  });
}
