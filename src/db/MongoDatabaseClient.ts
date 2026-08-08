import { type Db, MongoClient } from "mongodb"

export default class MongoDatabaseClient {
	#client: MongoClient
	#db?: Db | null

	constructor() {
		const connectionString = process.env.DB_CONN_STRING
		if (!connectionString) {
			throw new Error("Missing DB_CONN_STRING in env")
		}
		// Without this, driver silently converts explicit `undefined`
		// field values to BSON `null` on write - indistinguishable from a
		// confirmed-absent tri-state field
		this.#client = new MongoClient(connectionString, { ignoreUndefined: true })
	}

	async connect(): Promise<MongoClient> {
		if (this.#db) return this.#db.client

		const mongoClient = await this.#client.connect()
		const dbName = process.env.DB_NAME
		if (!dbName) {
			throw new Error("Missing DB_NAME in env")
		}
		this.#db = this.#client.db(dbName)
		return mongoClient
	}

	async getDb(): Promise<Db> {
		if (!this.#db) {
			await this.connect()
		}
		// @ts-expect-error this.#db is not null after this.connect()
		return this.#db
	}

	async disconnect(): Promise<void> {
		await this.#client.close()
		this.#db = null
	}
}
