import { TimeDict, TimeBlock } from '@/algorithm/ScheduleGenerator';

/**
 * Parse `MoWeFr 10:00AM - 11:00AM` to `[['Mo', 'We', 'Fr'], [10*60, 11*60]]`
 * returns null when fail to parse
 * @param time
 */
export function parseTimeAll(time: string): [string[], TimeBlock] | null {
    const [days, start, , end] = time.split(' ');
    if (days && start && end) {
        const dayList = [];
        for (let i = 0; i < days.length; i += 2) {
            dayList.push(days.substr(i, 2));
        }
        return [dayList, parseTimeAsInt(start, end)];
    }
    return null;
}
/**
 * Parse time in `['10:00AM', '11:00AM']` format to `[600, 660]` (number of minutes from 0:00),
 * assuming that the start time is always smaller (earlier) than end time
 * @param start start time such as `10:00AM`
 * @param end  end time such as `11:00AM`
 */
export function parseTimeAsInt(start: string, end: string): TimeBlock {
    let suffix = start.substr(start.length - 2, 2);
    let start_time: number;
    let end_time: number;
    let hour: string, minute: string;
    if (suffix === 'PM') {
        [hour, minute] = start.substring(0, start.length - 2).split(':');
        start_time = ((+hour % 12) + 12) * 60 + +minute;

        [hour, minute] = end.substring(0, end.length - 2).split(':');
        end_time = ((+hour % 12) + 12) * 60 + +minute;
    } else {
        const t1 = start.substring(0, start.length - 2).split(':');
        start_time = +t1[0] * 60 + +t1[1];
        suffix = end.substr(end.length - 2, 2);
        [hour, minute] = end.substring(0, end.length - 2).split(':');
        if (suffix === 'PM') {
            end_time = ((+hour % 12) + 12) * 60 + +minute;
        } else {
            end_time = +hour * 60 + +minute;
        }
    }
    return [start_time, end_time];
}

export function parseTimeAsString(start: string, end: string): [string, string] {
    let suffix = start.substr(start.length - 2, 2);
    let start_time: string;
    let end_time: string;
    if (suffix === 'PM') {
        let [hour, minute] = start.substring(0, start.length - 2).split(':');
        start_time = `${(+hour % 12) + 12}:${minute}`;

        [hour, minute] = end.substring(0, end.length - 2).split(':');
        end_time = `${(+hour % 12) + 12}:${minute}`;
    } else {
        start_time = start.substring(0, start.length - 2);
        suffix = end.substr(end.length - 2, 2);
        const temp = end.substring(0, end.length - 2);
        if (suffix === 'PM') {
            const [hour, minute] = temp.split(':');
            end_time = `${(+hour % 12) + 12}:${minute}`;
        } else {
            end_time = temp;
        }
    }
    return [start_time, end_time];
}

/**
 * return true of two `TimeDict` objects have overlapping time blocks, false otherwise
 * @param timeDict1
 * @param timeDict2
 */
export function checkTimeConflict(timeDict1: TimeDict, timeDict2: TimeDict) {
    for (const dayBlock in timeDict1) {
        const timeBlocks2 = timeDict2[dayBlock];
        if (!timeBlocks2) {
            continue;
        }
        // if the key exists, it cannot be undefined.
        const timeBlocks1 = timeDict1[dayBlock] as number[];

        for (let i = 0; i < timeBlocks1.length; i += 2) {
            const begin = timeBlocks1[i];
            const end = timeBlocks1[i + 1];
            for (let j = 0; j < timeBlocks2.length; j += 2) {
                const beginTime = timeBlocks2[j];
                const endTime = timeBlocks2[j + 1];
                if (
                    (begin <= beginTime && beginTime <= end) ||
                    (begin <= endTime && endTime <= end) ||
                    (begin >= beginTime && end <= endTime)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * convert 24 hour format time to 12 hour format
 * e.g. from `17:00` to `5:00PM`
 * @author Kaiying Shan
 * @param time the time in 24 hour format, e.g. 17:00
 */
export function to12hr(time: string) {
    const sep = time.split(':');
    const hr = parseInt(sep[0]);
    if (hr === 12) {
        return time + 'PM';
    } else if (hr < 12) {
        return time + 'AM';
    } else {
        return hr - 12 + ':' + sep[1] + 'PM';
    }
}

/**
 * Calculate a 32 bit FNV-1a hash
 * @see https://gist.github.com/vaiorabbit/5657561
 * @see http://isthe.com/chongo/tech/comp/fnv/
 * @param str the input string to hash
 * @returns a 32-bit unsigned integer
 */
export function hashCode(str: string): number {
    let hval = 0x811c9dc5;

    for (let i = 0, l = str.length; i < l; i++) {
        hval ^= str.charCodeAt(i);
        hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
    }
    return hval >>> 0;
}
