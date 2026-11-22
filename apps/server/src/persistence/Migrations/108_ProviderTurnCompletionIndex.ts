import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_thread_completed_idx
    ON orchestration_v2_projection_provider_turns(thread_id, completed_at)
    WHERE completed_at IS NOT NULL
  `;
});
