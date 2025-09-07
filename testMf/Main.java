import com.ibm.connector2.cics.*;
import com.ibm.etools.marshall.util.*;

public class Main {
    public static void main(String[] args) {
        try {
            SystemZConnector connector = new SystemZConnector("mainframe-host", "userid", "password");
            connector.connectAndReadCobol("PROD.COBOL.SOURCE", "MYPROG");
        } catch (Exception e) {
            System.err.println("שגיאה בחיבור ל-System z: " + e.getMessage());
        }
    }
}
