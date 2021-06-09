import { INode, IStatusCodeMessages, JsonObject} from '.';
import { parseString } from 'xml2js';

/**
 * Top-level properties where an error message can be found in an API response.
 */
const ERROR_MESSAGE_PROPERTIES = [
	'error',
	'message',
	'Message',
	'msg',
	'messages',
	'description',
	'reason',
	'detail',
	'details',
	'errors',
	'errorMessage',
	'errorMessages',
	'ErrorMessage',
	'error_message',
	'_error_message',
	'errorDescription',
	'error_description',
	'error_summary',
	'title',
	'text',
	'field',
	'err',
	'type',
];

/**
 * Top-level properties where an HTTP error code can be found in an API response.
 */
const ERROR_STATUS_PROPERTIES = ['statusCode', 'status', 'code', 'status_code', 'errorCode', 'error_code'];

/**
 * Properties where a nested object can be found in an API response.
 */
const ERROR_NESTING_PROPERTIES = ['error', 'err', 'response', 'body', 'data'];

/**
 * Base class for specific NodeError-types, with functionality for finding
 * a value recursively inside an error object.
 */
abstract class NodeError extends Error {
	description: string | null | undefined;
	cause: Error | JsonObject;
	node: INode;
	timestamp: number;

	constructor(node: INode, error: Error | JsonObject) {
		super();
		this.removeCircularRefs(error as JsonObject);
		this.name = this.constructor.name;
		this.cause = error;
		this.node = node;
		this.timestamp = Date.now();

		if (error.message) {
			this.message = error.message as string;
		}
	}

	/**
	 * Finds property through exploration based on potential keys and traversal keys.
	 * Depth-first approach.
	 *
	 * This method iterates over `potentialKeys` and, if the value at the key is a
	 * truthy value, the type of the value is checked:
	 * (1) if a string or number, the value is returned as a string; or
	 * (2) if an array,
	 * 		its string or number elements are collected as a long string,
	 * 		its object elements are traversed recursively (restart this function
	 *    with each object as a starting point), or
	 * (3) if it is an object, it traverses the object and nested ones recursively
	 * 		based on the `potentialKeys` and returns a string if found.
	 *
	 * If nothing found via `potentialKeys` this method iterates over `traversalKeys` and
	 * if the value at the key is a traversable object, it restarts with the object as the
	 * new starting point (recursion).
	 * If nothing found for any of the `traversalKeys`, exploration continues with remaining
	 * `traversalKeys`.
	 *
	 * Otherwise, if all the paths have been exhausted and no value is eligible, `null` is
	 * returned.
	 *
	 * @param {JsonObject} error
	 * @param {string[]} potentialKeys
	 * @param {string[]} traversalKeys
	 * @returns {string | null}
	 */
	protected findProperty(
		error: JsonObject,
		potentialKeys: string[],
		traversalKeys: string[] = [],
	): string | null {
		for(const key of potentialKeys) {
			if (error[key]) {
				if (typeof error[key] === 'string') return error[key] as string;
				if (typeof error[key] === 'number') return error[key]!.toString();
				if (Array.isArray(error[key])) {
					// @ts-ignore
					const resolvedErrors: string[] = error[key].map((error) => {
							if (typeof error === 'string') return error;
							if (typeof error === 'number') return error.toString();
							if (this.isTraversableObject(error)) {
								return this.findProperty(error, potentialKeys);
							}
							return null;
						})
						.filter((errorValue: string | null) => errorValue !== null);

					if (resolvedErrors.length === 0) {
						return null;
					}
					return resolvedErrors.join(' | ');
				}
				if (this.isTraversableObject(error[key])) {
					const property = this.findProperty(error[key] as JsonObject, potentialKeys);
					if (property) {
						return property;
					}
				}
			}
		}

		for (const key of traversalKeys) {
			if (this.isTraversableObject(error[key])) {
				const property = this.findProperty(error[key] as JsonObject, potentialKeys, traversalKeys);
				if (property) {
					return property;
				}
			}
		}

		return null;
	}

	/**
	 * Check if a value is an object with at least one key, i.e. it can be traversed.
	 */
	protected isTraversableObject(value: any): value is JsonObject { // tslint:disable-line:no-any
		return value && typeof value === 'object' && !Array.isArray(value) && !!Object.keys(value).length;
	}

	/**
	 * Remove circular references from objects.
	 */
	 protected removeCircularRefs(obj: JsonObject, seen = new Set()) {
		seen.add(obj);
		Object.entries(obj).forEach(([key, value]) => {
			if (this.isTraversableObject(value)) {
				seen.has(value) ? obj[key] = '[circular]' : this.removeCircularRefs(value, seen);
				return;
			}
			if (Array.isArray(value)) {
				value.forEach((val, index) => {
					seen.has(val)
						? value[index] = '[circular]'
						// tslint:disable-next-line: no-unused-expression
						: (this.isTraversableObject(val) && this.removeCircularRefs(val, seen));
				});
			}
		});
	}
}

/**
 * Class for instantiating an operational error, e.g. an invalid credentials error.
 */
export class NodeOperationError extends NodeError {

	constructor(node: INode, error: Error | string) {
		if (typeof error === 'string') {
			error = new Error(error);
		}
		super(node, error);
	}
}

const STATUS_CODE_MESSAGES: IStatusCodeMessages = {
	'4XX': 'Your request is invalid or could not be processed by the service',
	'400': 'Bad request - please check your parameters',
	'401': 'Authorization failed - please check your credentials',
	'402': 'Payment required - perhaps check your payment details?',
	'403': 'Forbidden - perhaps check your credentials?',
	'404': 'The resource you are requesting could not be found',
	'405': 'Method not allowed - please check you are using the right HTTP method',
	'429': 'The service is receiving too many requests from you! Perhaps take a break?',

	'5XX': 'The service failed to process your request',
	'500': 'The service was not able to process your request',
	'502': 'Bad gateway - the service failed to handle your request',
	'503': 'Service unavailable - perhaps try again later?',
	'504': 'Gateway timed out - perhaps try again later?',
};

const UNKNOWN_ERROR_MESSAGE = 'UNKNOWN ERROR - check the detailed error for more information';

/**
 * Class for instantiating an error in an API response, e.g. a 404 Not Found response,
 * with an HTTP error code, an error message and a description.
 */
export class NodeApiError extends NodeError {
	httpCode: string | null;

	constructor(
		node: INode,
		error: JsonObject,
		{ message, description, httpCode, parseXml }: { message?: string, description?: string, httpCode?: string, parseXml?: boolean } = {},
	) {
		super(node, error);
		if (message) {
			this.message = message;
			this.description = description;
			this.httpCode = httpCode ?? null;
			return;
		}

		this.httpCode = this.findProperty(error, ERROR_STATUS_PROPERTIES, ERROR_NESTING_PROPERTIES);
		this.setMessage();

		if (parseXml) {
			this.setDescriptionFromXml(error.error as string);
			return;
		}

		this.description = this.findProperty(error, ERROR_MESSAGE_PROPERTIES, ERROR_NESTING_PROPERTIES);
	}

	private setDescriptionFromXml(xml: string) {
		parseString(xml, { explicitArray: false }, (_, result) => {
			if (!result) return;

			const topLevelKey = Object.keys(result)[0];
			this.description = this.findProperty(result[topLevelKey], ERROR_MESSAGE_PROPERTIES, ['Error'].concat(ERROR_NESTING_PROPERTIES));
		});
	}

	/**
	 * Set the error's message based on the HTTP status code.
	 *
	 * @returns {void}
	 */
	private setMessage() {
		if (!this.httpCode) {
			this.httpCode = null;
			this.message = UNKNOWN_ERROR_MESSAGE;
			return;
		}

		if (STATUS_CODE_MESSAGES[this.httpCode]) {
			this.message = STATUS_CODE_MESSAGES[this.httpCode];
			return;
		}

		switch (this.httpCode.charAt(0)) {
			case '4':
				this.message = STATUS_CODE_MESSAGES['4XX'];
				break;
			case '5':
				this.message = STATUS_CODE_MESSAGES['5XX'];
				break;
			default:
				this.message = UNKNOWN_ERROR_MESSAGE;
		}
	}
}
