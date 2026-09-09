import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Journal, type SqlDriver } from "../src/journal";

for (const stop of ["break", "throw"] as const) test(`journal scan restarts after consumer ${stop}`, () => {
  const database=new Database(":memory:"),journal=new Journal(database as unknown as SqlDriver);
  try {
    journal.db.exec("CREATE TABLE cursor_test(value INTEGER); INSERT INTO cursor_test VALUES(1),(2),(3)");
    const query=journal.db.query("SELECT value FROM cursor_test ORDER BY value");
    for(let attempt=0;attempt<3;attempt++) {
      try {for(const row of query.iterate()) {expect(row).toEqual({value:1});if(stop==="throw")throw new Error("consumer limit");break;}}
      catch(error) {expect((error as Error).message).toBe("consumer limit");}
      expect([...query.iterate()]).toEqual([{value:1},{value:2},{value:3}]);
    }
  } finally {journal.close();}
});

test("overlapping journal cursors keep independent parameters and positions", () => {
  const database=new Database(":memory:"),journal=new Journal(database as unknown as SqlDriver);
  try {
    journal.db.exec("CREATE TABLE cursor_test(value INTEGER); INSERT INTO cursor_test VALUES(1),(2),(3)");
    const query=journal.db.query("SELECT value FROM cursor_test WHERE value>=? ORDER BY value");
    const first=query.iterate(1)[Symbol.iterator](),second=query.iterate(2)[Symbol.iterator]();
    expect(first.next().value).toEqual({value:1});
    expect(second.next().value).toEqual({value:2});
    first.return?.();
    expect(second.next().value).toEqual({value:3});
    expect(second.next().done).toBe(true);
    expect([...query.iterate(1)]).toEqual([{value:1},{value:2},{value:3}]);
  } finally {journal.close();}
});
