import 'package:sembast/sembast.dart';
import 'journal_io.dart'
    if (dart.library.js_interop) 'journal_web.dart'
    as platform;

/// Only synthetic demo state is supported. Live credentials are never stored here.
abstract interface class Journal {
  Future<Map<String, dynamic>?> read(String key);
  Future<void> write(String key, Map<String, dynamic> value);
  Future<void> clear({bool preservePendingOperations = false});
}

class DurableJournal implements Journal {
  DurableJournal(this.database);
  final Database database;
  final _records = stringMapStoreFactory.store('demo_client');

  static Future<DurableJournal> open() async =>
      DurableJournal(await platform.openJournalDatabase());

  @override
  Future<Map<String, dynamic>?> read(String key) async {
    final value = await _records.record(key).get(database);
    return value == null ? null : Map<String, dynamic>.from(value);
  }

  @override
  Future<void> write(String key, Map<String, dynamic> value) async {
    await database.transaction((transaction) async {
      await _records.record(key).put(transaction, value);
    });
  }

  @override
  Future<void> clear({bool preservePendingOperations = false}) async {
    await database.transaction((transaction) async {
      final rows = await _records.find(transaction);
      for (final row in rows) {
        if (preservePendingOperations &&
            ((row.key.endsWith(':pending') && row.value['operation'] is Map) ||
                (row.key.endsWith(':saved_upload') &&
                    row.value['file'] is Map &&
                    row.value['status'] == 'saved_unbound'))) {
          continue;
        }
        await _records.record(row.key).delete(transaction);
      }
    });
  }
}

class MemoryJournal implements Journal {
  final Map<String, Map<String, dynamic>> records = {};
  @override
  Future<Map<String, dynamic>?> read(String key) async => records[key];
  @override
  Future<void> write(String key, Map<String, dynamic> value) async {
    records[key] = Map<String, dynamic>.from(value);
  }

  @override
  Future<void> clear({bool preservePendingOperations = false}) async {
    records.removeWhere(
      (key, value) =>
          !preservePendingOperations ||
          !((key.endsWith(':pending') && value['operation'] is Map) ||
              (key.endsWith(':saved_upload') &&
                  value['file'] is Map &&
                  value['status'] == 'saved_unbound')),
    );
  }
}
