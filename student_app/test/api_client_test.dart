import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:campus_student/data/api_client.dart';

http.Response envelope(Json data, {String mode = 'demo', int status = 200}) =>
    http.Response(
      jsonEncode({
        'data': data,
        'meta': {
          'mode': mode,
          'request_id': 'req_test_001',
          'server_time': '2026-10-15T20:00:00+08:00',
        },
      }),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

void main() {
  test('late response from a previous account is discarded', () async {
    final wait = Completer<http.Response>();
    final api = ApiClient(
      origin: 'http://127.0.0.1:18765',
      client: MockClient((_) => wait.future),
    );
    api.useDemoAccount('a');
    final request = api.request('GET', '/v1/me');
    api.useDemoAccount('b');
    wait.complete(envelope({'user_id': 'student_a'}));
    await expectLater(request, throwsA(isA<StaleSession>()));
    api.close();
  });

  test('401 invalidates the same account in-flight requests', () async {
    final delayed = Completer<http.Response>();
    final api = ApiClient(
      origin: 'http://127.0.0.1:18765',
      client: MockClient((request) async {
        if (request.url.path == '/v1/me') return delayed.future;
        return http.Response(
          jsonEncode({
            'error': {
              'code': 'AUTH_REQUIRED',
              'message': 'expired',
              'retryable': false,
              'details': {},
            },
            'meta': {'request_id': 'req_auth'},
          }),
          401,
        );
      }),
    );
    api.useDemoAccount('a');
    final old = api.request('GET', '/v1/me');
    await expectLater(
      api.request('GET', '/v1/me/tasks'),
      throwsA(isA<ApiFailure>()),
    );
    delayed.complete(envelope({'user_id': 'student_a'}));
    await expectLater(old, throwsA(isA<StaleSession>()));
    api.close();
  });

  test('demo build refuses a live response and remote origins', () async {
    expect(() => ApiClient(origin: 'https://example.com'), throwsArgumentError);
    final api = ApiClient(
      origin: 'http://127.0.0.1:18765',
      client: MockClient((_) async => envelope({}, mode: 'live')),
    );
    await expectLater(
      api.request('GET', '/v1/me'),
      throwsA(isA<ApiFailure>().having((e) => e.code, 'code', 'MODE_MISMATCH')),
    );
    api.close();
  });

  test('transport does not retry a failed formal write', () async {
    var calls = 0;
    final api = ApiClient(
      origin: 'http://127.0.0.1:18765',
      client: MockClient((_) async {
        calls++;
        throw http.ClientException('response lost');
      }),
    );
    await expectLater(
      api.request(
        'POST',
        '/v1/tasks/task_demo/submissions',
        body: {},
        key: 'operation_test',
      ),
      throwsA(
        isA<ApiFailure>().having(
          (e) => e.definitiveRejection,
          'definitive',
          false,
        ),
      ),
    );
    expect(calls, 1);
    api.close();
  });
}
