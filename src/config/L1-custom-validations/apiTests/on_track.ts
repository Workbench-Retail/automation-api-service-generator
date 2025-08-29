/* eslint-disable no-prototype-builtins */
import constants  from "../utils/constants";
import { contextChecker } from "../utils/contextUtils";
import _ from "lodash";

interface ValidationError {
  valid: boolean;
  code: number;
  description: string;
}

const TTL_IN_SECONDS: number = Number(process.env.TTL_IN_SECONDS) || 3600;

const addError = (
  result: ValidationError[],
  code: number,
  description: string
) => {
  result.push({ valid: false, code, description });
};

export async function on_track(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    try {
      await contextChecker(
        context,
        result,
        constants.ON_TRACK,
        constants.TRACK,
        true
      );
    } catch (err: any) {
      result.push({
        valid: false,
        code: 20000,
        description: err.message,
      });
      return result;
    }

    return result;
  } catch (error: any) {
    console.error(`!!Error in /${constants.ON_TRACK}: ${error.stack}`);
    addError(result, 20000, `Internal error: ${error.message}`);
    return result;
  }
}
