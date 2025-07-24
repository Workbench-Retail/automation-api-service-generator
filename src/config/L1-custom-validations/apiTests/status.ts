/* eslint-disable no-prototype-builtins */
import { RedisService } from "ondc-automation-cache-lib";
import constants from "../utils/constants";
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

export async function checkStatus(data: any) {
  const { context, message } = data;
  const result: ValidationError[] = [];
  const txnId = context?.transaction_id;

  try {
    try {
      await contextChecker(
        context,
        result,
        constants.STATUS,
        constants.ON_CONFIRM,
        true
      );
    } catch (err: any) {
      result.push({
        valid: false,
        code: 31003,
        description: err.message,
      });
      return result;
    }
    try {
      const confirmOrderId = await RedisService.getKey(`${txnId}_cnfrmOrdrId`);
      if (
        confirmOrderId &&
        message.order_id &&
        !_.isEqual(confirmOrderId, message.order_id)
      ) {
        addError(
          result,
          31003,
          `Order ID mismatch between /${constants.CONFIRM} (ID: ${confirmOrderId}) and /${constants.STATUS} (ID: ${message.order_id})`
        );
      }
    } catch (error: any) {
      console.error(
        `!!Error while comparing order ID in /${constants.STATUS}, ${error.stack}`
      );
      addError(
        result,
        20000,
        `Error while comparing order ID: ${error.message}`
      );
    }
    return result;
  } catch (error: any) {
    console.error(`!!Error in /${constants.STATUS}: ${error.stack}`);
    addError(result, 20000, `Internal error: ${error.message}`);
    return result;
  }
}
